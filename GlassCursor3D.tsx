import * as React from "react"
import { useEffect, useRef } from "react"
import * as THREE from "three"
import { addPropertyControls, ControlType, RenderTarget } from "framer"

/**
 * The GLTF loader is resolved at RUNTIME, not with a static import.
 *
 * Framer cannot resolve three's deep subpaths (three/examples/jsm/...), and a
 * static import that fails to resolve kills the whole module silently — the
 * component just never renders, with no error to go on. Probing at runtime
 * means a failure is reportable instead of fatal, and we can fall back through
 * three sources until one works.
 */
let loaderPromise: Promise<any> | null = null
function resolveGLTFLoader(): Promise<any> {
    if (loaderPromise) return loaderPromise
    const dyn = (s: string) => import(/* @vite-ignore */ s)
    const sources = [
        "three-stdlib",
        "three/examples/jsm/loaders/GLTFLoader.js",
        "https://esm.sh/three@0.160.1/examples/jsm/loaders/GLTFLoader.js",
    ]
    loaderPromise = (async () => {
        const tried: string[] = []
        for (const s of sources) {
            try {
                const mod: any = await dyn(s)
                if (mod?.GLTFLoader) return mod.GLTFLoader
                tried.push(`${s}: no GLTFLoader export`)
            } catch (e: any) {
                tried.push(`${s}: ${e?.message || e}`)
            }
        }
        throw new Error("no GLTF loader available — " + tried.join(" | "))
    })()
    return loaderPromise
}

/**
 * GlassCursor3D — ALLSEEN.
 *
 * Replaces the pointer with a live WebGL model. The canvas is only as big as
 * the cursor itself (default 140px) and is moved with a transform, so this
 * costs a fraction of a full-viewport renderer.
 *
 * PLACE THIS ONCE per page — it renders position: fixed, so its own layout box
 * is irrelevant. Two instances means two cursors.
 *
 * Upload the .glb with the Model property. Use a compressed file: a raw Meshy
 * or Blender export at tens of MB will stall the page. Meshopt and Draco-free
 * quantized files both load here.
 *
 * Accessibility:
 *   - prefers-reduced-motion: the cursor stays, but every bit of motion the
 *     user didn't ask for stops. No idle spin, no velocity tilt, no spring lag
 *     — it tracks the pointer exactly, 1:1.
 *   - forced-colors / no hover / coarse pointer: the custom cursor does not
 *     render and the system cursor is left alone. High-contrast and touch users
 *     keep the pointer their OS gave them, which is the one they can see.
 *   - The canvas is aria-hidden and pointer-events: none. It never intercepts
 *     a click and never appears in the accessibility tree.
 *
 * @framerIntrinsicWidth 160
 * @framerIntrinsicHeight 160
 * @framerDisableUnlink
 */

type MaterialMode = "original" | "glass" | "metal"

/**
 * A small studio "room" of emissive panels, built inline rather than imported
 * from three/examples. PMREM turns it into an environment map — glass has to
 * have something to refract or it renders as flat grey.
 */
function studioEnvironment(): {
    scene: THREE.Scene
    dispose: () => void
} {
    const scene = new THREE.Scene()
    const box = new THREE.BoxGeometry()
    box.deleteAttribute("uv")
    const owned: { dispose(): void }[] = [box]

    const panel = (
        color: number,
        intensity: number,
        scale: [number, number, number],
        pos: [number, number, number]
    ) => {
        const mat = new THREE.MeshBasicMaterial({ color })
        mat.color.multiplyScalar(intensity)
        const mesh = new THREE.Mesh(box, mat)
        mesh.scale.set(...scale)
        mesh.position.set(...pos)
        scene.add(mesh)
        owned.push(mat)
    }

    // Surrounding shell, seen from inside.
    const shell = new THREE.MeshBasicMaterial({
        color: 0x2a2a30,
        side: THREE.BackSide,
    })
    const room = new THREE.Mesh(box, shell)
    room.scale.setScalar(12)
    scene.add(room)
    owned.push(shell)

    panel(0xffffff, 6.0, [7, 0.4, 7], [0, 5.4, 0]) // key, overhead
    panel(0xfff0e0, 2.4, [0.4, 5, 5], [-5.4, 0.5, 0]) // warm fill, left
    panel(0xdce8ff, 2.0, [0.4, 5, 5], [5.4, 0.5, 0]) // cool fill, right
    panel(0xffffff, 1.6, [5, 5, 0.4], [0, 0.5, -5.4]) // rim, behind

    return { scene, dispose: () => owned.forEach((o) => o.dispose()) }
}

interface Props {
    modelFile: string
    modelUrl: string
    size: number
    modelScale: number
    rotationX: number
    rotationY: number
    rotationZ: number
    materialMode: MaterialMode
    tint: string
    roughness: number
    metalness: number
    transmission: number
    ior: number
    thickness: number
    envIntensity: number
    follow: number
    tilt: number
    idleSpin: number
    hideNativeCursor: boolean
    zIndex: number
    style?: React.CSSProperties
}

export default function GlassCursor3D(props: Partial<Props>) {
    const {
        modelFile = "",
        modelUrl = "",
        size = 140,
        modelScale = 1,
        rotationX = -90,
        rotationY = 0,
        rotationZ = 0,
        materialMode = "glass",
        tint = "#FFFFFF",
        roughness = 0.08,
        metalness = 0,
        transmission = 1,
        ior = 1.5,
        thickness = 0.6,
        envIntensity = 1.4,
        follow = 0.6,
        tilt = 1,
        idleSpin = 0.25,
        hideNativeCursor = true,
        zIndex = 99999,
        style,
    } = props

    const holderRef = useRef<HTMLDivElement>(null)
    const src = modelFile || modelUrl

    const isEditor =
        RenderTarget.current() === RenderTarget.canvas ||
        RenderTarget.current() === RenderTarget.thumbnail

    useEffect(() => {
        const holder = holderRef.current
        if (!holder || !src) return

        // ---- bail out where a custom cursor is the wrong answer -------------
        // No hover means no cursor to replace. Forced colors means the user has
        // told the OS they need its cursor, not ours.
        const noHover = window.matchMedia("(hover: none)").matches
        const coarse = window.matchMedia("(pointer: coarse)").matches
        const forced = window.matchMedia("(forced-colors: active)").matches
        if (!isEditor && (noHover || coarse || forced)) return

        const reduceMQ = window.matchMedia("(prefers-reduced-motion: reduce)")
        let reduced = reduceMQ.matches
        const onReduce = (e: MediaQueryListEvent) => {
            reduced = e.matches
        }
        reduceMQ.addEventListener?.("change", onReduce)

        // ---- renderer -------------------------------------------------------
        let renderer: THREE.WebGLRenderer
        try {
            renderer = new THREE.WebGLRenderer({
                alpha: true,
                antialias: true,
                powerPreference: "low-power",
            })
        } catch {
            return // No WebGL: leave the system cursor alone.
        }
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        renderer.setPixelRatio(dpr)
        renderer.setSize(size, size, false)
        renderer.setClearColor(0x000000, 0)
        renderer.outputColorSpace = THREE.SRGBColorSpace
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.toneMappingExposure = 1.1

        const canvas = renderer.domElement
        canvas.setAttribute("aria-hidden", "true")
        Object.assign(canvas.style, {
            width: size + "px",
            height: size + "px",
            display: "block",
            pointerEvents: "none",
        })
        holder.appendChild(canvas)

        const scene = new THREE.Scene()
        const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100)
        camera.position.set(0, 0, 3.2)

        // Procedural studio environment — glass needs something to refract.
        const pmrem = new THREE.PMREMGenerator(renderer)
        const studio = studioEnvironment()
        const envRT = pmrem.fromScene(studio.scene, 0.04)
        scene.environment = envRT.texture
        studio.dispose()

        scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 0.6))
        const key = new THREE.DirectionalLight(0xffffff, 2.2)
        key.position.set(2, 3, 4)
        scene.add(key)

        // ---- state ----------------------------------------------------------
        const pivot = new THREE.Group()
        scene.add(pivot)

        let x = window.innerWidth / 2
        let y = window.innerHeight / 2
        let cx = x
        let cy = y
        let vx = 0
        let vy = 0
        let tiltX = 0
        let tiltZ = 0
        let visible = false
        let raf = 0
        let t = 0
        let last = performance.now()
        let disposed = false

        const owned: { dispose(): void }[] = []

        // ---- load -----------------------------------------------------------
        // No Draco or meshopt decoder is wired up on purpose — each one is
        // another module Framer has to resolve. Ship a plain or quantized
        // .glb (KHR_mesh_quantization is handled natively) and nothing extra
        // is needed.
        const startLoad = (GLTFLoader: any) =>
            new GLTFLoader().load(
            src,
            (gltf) => {
                if (disposed) return
                const model = gltf.scene

                // Normalise: centre on origin, fit the longest axis to 1 unit,
                // so any model behaves the same regardless of export scale.
                const box = new THREE.Box3().setFromObject(model)
                const c = box.getCenter(new THREE.Vector3())
                const s = box.getSize(new THREE.Vector3())
                const longest = Math.max(s.x, s.y, s.z) || 1
                model.position.sub(c)

                const fit = new THREE.Group()
                fit.add(model)
                fit.scale.setScalar((1 / longest) * modelScale)
                pivot.add(fit)

                // ---- material --------------------------------------------------
                if (materialMode !== "original") {
                    model.traverse((o) => {
                        const mesh = o as THREE.Mesh
                        if (!mesh.isMesh) return
                        const old = mesh.material as THREE.MeshStandardMaterial
                        const next = new THREE.MeshPhysicalMaterial({
                            map: old?.map ?? null,
                            normalMap: old?.normalMap ?? null,
                            color: new THREE.Color(tint),
                            roughness,
                            metalness:
                                materialMode === "metal" ? 1 : metalness,
                            envMapIntensity: envIntensity,
                        })
                        if (materialMode === "glass") {
                            next.transmission = transmission
                            next.ior = ior
                            next.thickness = thickness
                            next.transparent = true
                            next.depthWrite = false
                        }
                        mesh.material = next
                        owned.push(next)
                        if (old?.dispose) old.dispose()
                    })
                }

                model.traverse((o) => {
                    const mesh = o as THREE.Mesh
                    if (mesh.isMesh && mesh.geometry) owned.push(mesh.geometry)
                })

                visible = true
                holder.style.opacity = "1"
            },
            undefined,
            (err) => {
                // Loading failed — leave the system cursor exactly as it was.
                console.warn("[GlassCursor3D] could not load model:", src, err)
                holder.style.opacity = "0"
                if (document.documentElement.style.cursor === "none")
                    document.documentElement.style.cursor = ""
            }
        )

        resolveGLTFLoader()
            .then((GLTFLoader) => {
                if (!disposed) startLoad(GLTFLoader)
            })
            .catch((e) => {
                console.warn("[GlassCursor3D]", e?.message || e)
                holder.style.opacity = "0"
                if (document.documentElement.style.cursor === "none")
                    document.documentElement.style.cursor = ""
            })

        // ---- pointer --------------------------------------------------------
        const onMove = (e: PointerEvent) => {
            x = e.clientX
            y = e.clientY
        }
        const onLeave = () => {
            holder.style.opacity = "0"
        }
        const onEnter = () => {
            if (visible) holder.style.opacity = "1"
        }
        if (!isEditor) {
            window.addEventListener("pointermove", onMove, { passive: true })
            document.addEventListener("pointerleave", onLeave)
            document.addEventListener("pointerenter", onEnter)
        }

        // ---- hide the system cursor ----------------------------------------
        const rootEl = document.documentElement
        const prevCursor = rootEl.style.cursor
        if (hideNativeCursor && !isEditor) rootEl.style.cursor = "none"

        // ---- loop -----------------------------------------------------------
        const tick = (now: number) => {
            raf = requestAnimationFrame(tick)
            const dt = Math.min((now - last) / 1000, 0.05)
            last = now
            if (!visible) return

            if (isEditor) {
                // Static preview, parked in the middle of the viewport.
                cx = window.innerWidth / 2
                cy = window.innerHeight / 2
                pivot.rotation.set(
                    THREE.MathUtils.degToRad(rotationX),
                    THREE.MathUtils.degToRad(rotationY),
                    THREE.MathUtils.degToRad(rotationZ)
                )
            } else if (reduced) {
                // Reduced motion: exact 1:1 tracking. No lag, no tilt, no spin.
                cx = x
                cy = y
                vx = 0
                vy = 0
                pivot.rotation.set(
                    THREE.MathUtils.degToRad(rotationX),
                    THREE.MathUtils.degToRad(rotationY),
                    THREE.MathUtils.degToRad(rotationZ)
                )
            } else {
                const k = 1 - Math.pow(1 - Math.min(0.99, follow), dt * 60)
                const nx = cx + (x - cx) * k
                const ny = cy + (y - cy) * k
                vx = (nx - cx) / (dt || 0.016)
                vy = (ny - cy) / (dt || 0.016)
                cx = nx
                cy = ny

                t += dt
                const clamp = (v: number) => Math.max(-0.6, Math.min(0.6, v))
                const targetZ = clamp(-vx * 0.0016 * tilt)
                const targetX = clamp(vy * 0.0016 * tilt)
                tiltZ += (targetZ - tiltZ) * Math.min(1, dt * 8)
                tiltX += (targetX - tiltX) * Math.min(1, dt * 8)

                pivot.rotation.set(
                    THREE.MathUtils.degToRad(rotationX) + tiltX,
                    THREE.MathUtils.degToRad(rotationY) + t * idleSpin,
                    THREE.MathUtils.degToRad(rotationZ) + tiltZ
                )
            }

            holder.style.transform = `translate3d(${cx}px, ${cy}px, 0) translate(-50%, -50%)`
            renderer.render(scene, camera)
        }
        raf = requestAnimationFrame(tick)

        // ---- teardown -------------------------------------------------------
        return () => {
            disposed = true
            cancelAnimationFrame(raf)
            window.removeEventListener("pointermove", onMove)
            document.removeEventListener("pointerleave", onLeave)
            document.removeEventListener("pointerenter", onEnter)
            reduceMQ.removeEventListener?.("change", onReduce)
            rootEl.style.cursor = prevCursor
            owned.forEach((o) => o.dispose())
            envRT.texture.dispose()
            pmrem.dispose()
            renderer.dispose()
            if (canvas.parentNode) canvas.parentNode.removeChild(canvas)
        }
    }, [
        src,
        size,
        modelScale,
        rotationX,
        rotationY,
        rotationZ,
        materialMode,
        tint,
        roughness,
        metalness,
        transmission,
        ior,
        thickness,
        envIntensity,
        follow,
        tilt,
        idleSpin,
        hideNativeCursor,
        isEditor,
    ])

    // In the Framer editor, show a labelled placeholder so the layer is findable.
    if (isEditor) {
        return (
            <div
                style={{
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    textAlign: "center",
                    border: "1px dashed rgba(0,0,0,.25)",
                    borderRadius: 12,
                    font: "500 12px/1.4 sans-serif",
                    color: "rgba(0,0,0,.55)",
                    padding: 12,
                    ...style,
                }}
            >
                {src ? "3D cursor — place once per page" : "Upload a .glb model"}
                <div
                    ref={holderRef}
                    aria-hidden="true"
                    style={{
                        position: "fixed",
                        top: 0,
                        left: 0,
                        width: size,
                        height: size,
                        pointerEvents: "none",
                        opacity: 0,
                        zIndex,
                    }}
                />
            </div>
        )
    }

    return (
        <div
            ref={holderRef}
            aria-hidden="true"
            style={{
                position: "fixed",
                top: 0,
                left: 0,
                width: size,
                height: size,
                pointerEvents: "none",
                opacity: 0,
                transition: "opacity .2s ease",
                willChange: "transform",
                zIndex,
                ...style,
            }}
        />
    )
}

addPropertyControls(GlassCursor3D, {
    modelFile: {
        type: ControlType.File,
        title: "Model",
        allowedFileTypes: ["glb", "gltf"],
        description:
            "Upload the compressed .glb. Keep it under ~1 MB — raw exports will stall the page.",
    },
    modelUrl: {
        type: ControlType.String,
        title: "…or URL",
        defaultValue: "",
        placeholder: "https://…/glass-cursor.glb",
    },
    size: {
        type: ControlType.Number,
        title: "Size",
        defaultValue: 140,
        min: 40,
        max: 400,
        step: 4,
        unit: "px",
    },
    modelScale: {
        type: ControlType.Number,
        title: "Fill",
        defaultValue: 1,
        min: 0.2,
        max: 2,
        step: 0.05,
        description: "How much of the canvas the model occupies.",
    },
    rotationX: {
        type: ControlType.Number,
        title: "Rotate X",
        defaultValue: -90,
        min: -180,
        max: 180,
        step: 1,
        unit: "°",
    },
    rotationY: {
        type: ControlType.Number,
        title: "Rotate Y",
        defaultValue: 0,
        min: -180,
        max: 180,
        step: 1,
        unit: "°",
    },
    rotationZ: {
        type: ControlType.Number,
        title: "Rotate Z",
        defaultValue: 0,
        min: -180,
        max: 180,
        step: 1,
        unit: "°",
    },
    materialMode: {
        type: ControlType.Enum,
        title: "Material",
        defaultValue: "glass",
        options: ["glass", "metal", "original"],
        optionTitles: ["Glass", "Metal", "As exported"],
    },
    tint: {
        type: ControlType.Color,
        title: "Tint",
        defaultValue: "#FFFFFF",
        hidden: (p) => p.materialMode === "original",
    },
    roughness: {
        type: ControlType.Number,
        title: "Roughness",
        defaultValue: 0.08,
        min: 0,
        max: 1,
        step: 0.01,
        hidden: (p) => p.materialMode === "original",
    },
    metalness: {
        type: ControlType.Number,
        title: "Metalness",
        defaultValue: 0,
        min: 0,
        max: 1,
        step: 0.01,
        hidden: (p) => p.materialMode !== "glass",
    },
    transmission: {
        type: ControlType.Number,
        title: "Transmission",
        defaultValue: 1,
        min: 0,
        max: 1,
        step: 0.01,
        hidden: (p) => p.materialMode !== "glass",
    },
    ior: {
        type: ControlType.Number,
        title: "IOR",
        defaultValue: 1.5,
        min: 1,
        max: 2.4,
        step: 0.01,
        hidden: (p) => p.materialMode !== "glass",
    },
    thickness: {
        type: ControlType.Number,
        title: "Thickness",
        defaultValue: 0.6,
        min: 0,
        max: 3,
        step: 0.05,
        hidden: (p) => p.materialMode !== "glass",
    },
    envIntensity: {
        type: ControlType.Number,
        title: "Reflections",
        defaultValue: 1.4,
        min: 0,
        max: 4,
        step: 0.1,
        hidden: (p) => p.materialMode === "original",
    },
    follow: {
        type: ControlType.Number,
        title: "Follow",
        defaultValue: 0.6,
        min: 0.05,
        max: 1,
        step: 0.05,
        description: "1 is locked to the pointer. Lower lags behind it.",
    },
    tilt: {
        type: ControlType.Number,
        title: "Tilt",
        defaultValue: 1,
        min: 0,
        max: 3,
        step: 0.1,
    },
    idleSpin: {
        type: ControlType.Number,
        title: "Idle spin",
        defaultValue: 0.25,
        min: 0,
        max: 2,
        step: 0.05,
    },
    hideNativeCursor: {
        type: ControlType.Boolean,
        title: "Hide system cursor",
        defaultValue: true,
        description:
            "Turn off to draw the 3D cursor alongside the real one — safer, and useful while positioning.",
    },
    zIndex: {
        type: ControlType.Number,
        title: "Z index",
        defaultValue: 99999,
        min: 1,
        max: 999999,
        step: 1,
    },
})
