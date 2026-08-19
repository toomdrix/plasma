Here is a complete, implementation-ready Software Requirements Specification (SRS) structured so you can either start building it yourself or feed it directly into an AI coding assistant to scaffold the application.

---

# Functional & Technical Specification: 2D Web Plasma CAM

**Project Name:** MicroPlasma CAM (or working title)

**Target Platform:** Mobile-responsive Progressive Web App (PWA) / Single Page Application

**Primary Goal:** Transform 2D DXF sketch exports (from Onshape) into optimized, plasma-ready GRBL G-code (`.nc`) with automated kerf offset, lead-ins, overburn, and piercing cycles.

---

## 1. System Architecture & Tech Stack

```
[ DXF Upload (FileReader) ]
           │
           ▼
[ DXF Parser (dxf-parser / ezdxf-wasm) ]
           │
           ▼
[ Topology & Nesting Engine (Clipper2 / Clipper-lib) ]
           │
           ├─► [ Canvas 2D / SVG Visualizer ] ◄─► [ Touch/Mouse Interaction ]
           │
           ▼
[ Plasma Toolpath Generator (Lead-in, Overburn, Feed Scaling) ]
           │
           ▼
[ Post-Processor (GRBL Plasma Formatter) ]
           │
           ▼
[ .nc / .gcode File Download ] ──► [ Grbl Controller + (Mobile) ]

```

* **Core Runtime:** Pure client-side TypeScript/JavaScript (React, Vue, or Vanilla Svelte for maximum mobile speed).
* **Geometry Engine:** `clipper-lib` / `clipper2-js` (Polygon offsetting, clipping, orientation).
* **DXF Parsing:** `dxf-parser` (Extracts `LINE`, `ARC`, `LWPOLYLINE`, `SPLINE`).
* **Rendering:** HTML5 Canvas (2D Context) or SVG with pan/zoom touch gestures.

---

## 2. Functional Requirements

### 2.1 Input & Parsing

* Accept standard 2D `.dxf` uploads via drag-and-drop or file picker.
* Stitch individual contiguous lines/arcs into closed path loops with a configurable tolerance (default: $0.05\text{ mm}$).
* Discretize cubic splines (`SPLINE` entities) into arc/line approximations.
* Reject or warn on unclosed geometries or non-planar 3D entities.

### 2.2 Geometric Topology & Kerf Offset

* **Loop Classification:**
* Build a containment hierarchy (Ray-Casting / Even-Odd rule).
* Outermost boundary (Depth 0, 2...) $\rightarrow$ **Outer Cut** (Kerf Offset Outward $+ \frac{\text{kerf}}{2}$).
* Inner cutouts / holes (Depth 1, 3...) $\rightarrow$ **Inner Cut** (Kerf Offset Inward $- \frac{\text{kerf}}{2}$).


* **Cut Direction (Conventional vs Climb):**
* Plasma produces a squarer edge on the right side of the torch travel direction.
* Internal holes: **Counter-Clockwise (CCW)**.
* External perimeters: **Clockwise (CW)**.



### 2.3 Lead-In & Lead-Out Engine

* **Outer Profiles:**
* Attach a tangential arc lead-in starting in the scrap material outside the part.
* Lead-in radius: $3\text{–}5\text{ mm}$, Sweep angle: $60^\circ\text{–}90^\circ$.
* Optional straight lead-out: $1\text{–}2\text{ mm}$.


* **Internal Holes / Cutouts:**
* Standard Holes ($> 2 \times \text{lead-in radius}$): Tangential arc starting inside the scrap slug.
* Small Bolt Holes ($< 2 \times \text{lead-in radius}$): Center-point pierce $\rightarrow$ straight radial lead-in directly to the cut boundary.



### 2.4 Plasma-Specific Hole Overburn & Feed Rules

* **Overburn (Hole Overrun):**
* When cutting closed circular holes, extend tool travel along the cut perimeter for an extra **$2.5\text{ mm to }4.0\text{ mm}$ past the $360^\circ$ start point**.
* Issue torch off (`M5`) at the $360^\circ$ mark while the machine travels through the overrun segment.


* **Small Hole Feed Reduction:**
* Automatically apply a feed rate multiplier (default: **$60\%$**) for any circular cut with diameter $< 30\text{ mm}$ to reduce bevel taper caused by arc lag.



### 2.5 Cut Ordering Optimization

* Sort operations to guarantee mechanical integrity:
1. **All internal holes/cutouts first** (sorted via nearest-neighbor to minimize rapid travel).
2. **Outer boundary last**.

### 2.6 Datum / Origin Alignment Control

Provide a 9-point anchor selector (Corners, Edge Midpoints, Center) plus "Original CAD Origin". The generator must translate all geometry so the chosen anchor point equals $(X0, Y0)$ in the output G-code.

Default to Bottom-Left.



---

## 3. UI / UX Requirements (Mobile First)

1. **Top Bar:** Quick presets (e.g., *1.5mm Mild Steel*, *3mm Aluminium*, *16ga Sheet*).
2. **Interactive Viewport:**
* DXF geometry in dark grey.
* Toolpath centerlines in blue.
* Rapid travels (`G0`) in dashed yellow.
* Pierce points in red.
* Tap any loop to cycle the lead-in start node location or flip offset direction.


3. **Parameter Flyout Panel:**
* Cut Feed Rate (`mm/min`)
* Pierce Delay (`G4 P...` in seconds)
* Kerf Width (`mm`)
* Lead-in Type (Arc / Line / Center Pierce) & Radius (`mm`)
* Overburn Distance (`mm`)
* Small Hole Speed Scale (`%`)


4. **Export Button:** Single-tap download generating a clean `.nc` or `.gcode` file.

---

## 4. G-Code Post-Processor Template (GRBL Target)

```gcode
(Header)
G21 (Metric)
G90 (Absolute Distance)
G94 (Feed mm/min)

(--- Operation: Internal Hole 1 ---)
G0 X[Pierce_X] Y[Pierce_Y]
M3 S1000                  (Torch Relay ON)
G4 P[Pierce_Delay]        (Dwell for pilot arc blowout)
G2/G3 X... Y... I... J... (Lead-in arc)
G1/G2/G3 ... F[Hole_Feed] (Cut perimeter 360 deg)
M5                        (Torch OFF at 360 deg mark)
G2/G3 ...                 (Overburn travel through cut line)
G0 Z0 (Optional clear)

(--- Operation: Outer Perimeter ---)
G0 X[Pierce_X] Y[Pierce_Y]
M3 S1000
G4 P[Pierce_Delay]
G2/G3 X... Y... I... J... (Lead-in arc)
G1/G2/G3 ... F[Cut_Feed]  (Cut perimeter)
M5                        (Torch OFF)

(Footer)
G0 X0 Y0
M2

```

---

## 5. Non-Functional Requirements & Constraints

* **Offline Capability:** Fully operational without an active internet connection (PWA Service Worker).
* **Zero Backend Dependency:** All geometry and file parsing must run entirely in the browser memory for instant execution and privacy.
* **Touch-Optimized Controls:** Touch gestures for pinch-to-zoom, two-finger pan, and large tap targets for machine parameters.