/* ═══════════════════════════════════════════════════════
   CALISTHENICS MAP — Interactive Bodyweight Skill Tree
   Custom canvas renderer with deterministic layout,
   localStorage progress tracking, and pan/zoom.
   ═══════════════════════════════════════════════════════ */

(() => {
'use strict';

// ─── Layout Constants ────────────────────────────────
const NODE_W  = 168;
const NODE_H  = 44;
const NODE_GAP = 22;           // vertical gap between nodes in same tier
const TIER_SPACING = 260;      // horizontal space between tier columns
const LANE_PAD = 40;           // vertical padding within each category lane
const LANE_GAP = 50;           // gap between category lanes
const START_X  = 140;          // x-offset for tier 1 column
const LABEL_X  = 24;           // x-position for lane labels

const CATEGORIES = ['Push', 'Pull', 'Core', 'Legs'];

const COLORS = {
    Push: { r: 232, g: 85,  b: 78  },
    Pull: { r: 77,  g: 157, b: 224 },
    Core: { r: 59,  g: 178, b: 115 },
    Legs: { r: 232, g: 168, b: 56  },
};

const STORAGE_KEY = 'calisthenics-map-progress';

// ─── Application State ───────────────────────────────
let exercises     = [];
let exerciseMap   = {};   // id → exercise object
let nodePositions = {};   // id → { x, y, w, h }
let laneInfo      = {};   // category → { yStart, yEnd, midY }
let edgeList      = [];   // precomputed [{ from, to }]
let completed     = new Set();

let canvas, ctx, dpr;
let camera       = { x: 0, y: 0, zoom: window.innerWidth < 768 ? 0.6 : 1 };
let targetCamera = null;
let hoveredNode  = null;
let selectedNode = null;
let isDragging   = false;
let dragStart    = { x: 0, y: 0 };
let dragCameraStart = { x: 0, y: 0 };
let needsRender  = true;
let worldBounds  = null;

// ═════════════════════════════════════════════════════
//  INITIALISATION
// ═════════════════════════════════════════════════════

async function init() {
    try {
        const resp = await fetch('data.json');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        exercises = await resp.json();
    } catch (err) {
        document.getElementById('canvas-area').innerHTML =
            `<p style="color:var(--color-push);padding:40px;font-size:1rem;">
             Failed to load data.json — check the console (F12).</p>`;
        console.error(err);
        return;
    }

    // Index exercises
    exercises.forEach(ex => { exerciseMap[ex.id] = ex; });

    // Precompute edge list
    exercises.forEach(ex => {
        (ex.unlocks || []).forEach(targetId => {
            if (exerciseMap[targetId]) {
                edgeList.push({ from: ex.id, to: targetId });
            }
        });
    });

    loadProgress();
    computeLayout();
    worldBounds = computeWorldBounds();

    // Canvas setup
    canvas = document.getElementById('skill-canvas');
    ctx    = canvas.getContext('2d');
    dpr    = window.devicePixelRatio || 1;

    // Wait for Inter to load so canvas text renders correctly
    await document.fonts.ready;

    resizeCanvas();
    fitAll(false);

    setupCanvasEvents();
    setupUIEvents();
    setupSearch();
    updateProgress();

    requestAnimationFrame(loop);

    // Auto-hide hint
    setTimeout(() => {
        document.getElementById('canvas-hint')?.classList.add('fade');
    }, 5000);
}

// ═════════════════════════════════════════════════════
//  LAYOUT ENGINE
//  Groups nodes into category swim-lanes, ordered by
//  DFS within each category so sub-trees cluster.
// ═════════════════════════════════════════════════════

function computeLayout() {
    nodePositions = {};
    laneInfo = {};
    let currentY = 0;

    for (const category of CATEGORIES) {
        const catExercises = exercises.filter(e => e.category === category);
        const catIds = new Set(catExercises.map(e => e.id));

        // Find roots: exercises with no in-category prerequisites
        const roots = catExercises.filter(e =>
            e.prerequisites.length === 0 ||
            e.prerequisites.every(p => !catIds.has(p))
        );

        // DFS to produce a vertical ordering that clusters sub-trees
        const visited = new Set();
        const ordered = [];

        function dfs(id) {
            if (visited.has(id) || !catIds.has(id)) return;
            visited.add(id);
            ordered.push(id);
            const ex = exerciseMap[id];
            (ex.unlocks || []).filter(u => catIds.has(u)).forEach(dfs);
        }
        roots.forEach(r => dfs(r.id));
        // Safety: add any unvisited
        catExercises.forEach(e => { if (!visited.has(e.id)) ordered.push(e.id); });

        // Group by tier
        const byTier = {};
        ordered.forEach(id => {
            const t = exerciseMap[id].tier;
            (byTier[t] = byTier[t] || []).push(id);
        });

        // Lane height = tallest column
        const maxInTier = Math.max(...Object.values(byTier).map(a => a.length));
        const laneH = maxInTier * (NODE_H + NODE_GAP) - NODE_GAP + LANE_PAD * 2;
        const laneMid = currentY + laneH / 2;

        laneInfo[category] = { yStart: currentY, yEnd: currentY + laneH, midY: laneMid };

        // Position nodes
        for (const [tier, ids] of Object.entries(byTier)) {
            const x = START_X + (tier - 1) * TIER_SPACING;
            const colH = ids.length * (NODE_H + NODE_GAP) - NODE_GAP;
            const topY = laneMid - colH / 2;

            ids.forEach((id, idx) => {
                nodePositions[id] = {
                    x, y: topY + idx * (NODE_H + NODE_GAP),
                    w: NODE_W, h: NODE_H,
                };
            });
        }

        currentY += laneH + LANE_GAP;
    }
}

function computeWorldBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of Object.values(nodePositions)) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + p.w);
        maxY = Math.max(maxY, p.y + p.h);
    }
    if (minX === Infinity) return null;
    
    // Add padding so nodes aren't hard against the screen edge
    const padX = 300;
    const padY = 300;
    return { 
        minX: minX - padX, 
        minY: minY - padY, 
        maxX: maxX + padX, 
        maxY: maxY + padY 
    };
}

function clampCamera(cam) {
    if (!worldBounds || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const vw = rect.width;
    const vh = rect.height;

    const minCamX = vw - (worldBounds.maxX * cam.zoom);
    const maxCamX = -(worldBounds.minX * cam.zoom);
    const minCamY = vh - (worldBounds.maxY * cam.zoom);
    const maxCamY = -(worldBounds.minY * cam.zoom);

    if (minCamX <= maxCamX) {
        cam.x = Math.max(minCamX, Math.min(maxCamX, cam.x));
    } else {
        cam.x = (vw - (worldBounds.maxX + worldBounds.minX) * cam.zoom) / 2;
    }

    if (minCamY <= maxCamY) {
        cam.y = Math.max(minCamY, Math.min(maxCamY, cam.y));
    } else {
        cam.y = (vh - (worldBounds.maxY + worldBounds.minY) * cam.zoom) / 2;
    }
}

// ═════════════════════════════════════════════════════
//  PROGRESS SYSTEM
// ═════════════════════════════════════════════════════

function getNodeState(id) {
    if (completed.has(id)) return 'completed';
    const ex = exerciseMap[id];
    if (!ex) return 'locked';
    if (!ex.prerequisites || ex.prerequisites.length === 0) return 'available';
    return ex.prerequisites.every(p => completed.has(p)) ? 'available' : 'locked';
}

function toggleComplete(id) {
    const st = getNodeState(id);
    if (st === 'locked') return;

    if (completed.has(id)) {
        // Uncomplete + cascade downstream
        completed.delete(id);
        let changed = true;
        while (changed) {
            changed = false;
            for (const cid of [...completed]) {
                if (exerciseMap[cid].prerequisites.some(p => !completed.has(p))) {
                    completed.delete(cid);
                    changed = true;
                }
            }
        }
        saveProgress();
        updateProgress();
        showToast('↩ Progress updated');
    } else {
        completed.add(id);
        saveProgress();
        updateProgress();
        showToast(`🎉 ${exerciseMap[id].name} completed!`);
    }

    needsRender = true;
    if (selectedNode) showPanel(selectedNode);
}

function saveProgress() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...completed])); }
    catch (_) { /* quota exceeded — non-critical */ }
}

function loadProgress() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) completed = new Set(JSON.parse(raw));
    } catch (_) {}
}

function updateProgress() {
    const total = exercises.length;
    const done  = completed.size;
    const pct   = total ? (done / total * 100) : 0;
    const fill  = document.getElementById('progress-bar-fill');
    const text  = document.getElementById('progress-text');
    if (fill) fill.style.width = pct + '%';
    if (text) text.textContent = `${done} / ${total}`;
}

// ═════════════════════════════════════════════════════
//  CANVAS — SIZING & RENDER LOOP
// ═════════════════════════════════════════════════════

function resizeCanvas() {
    const rect = document.getElementById('canvas-area').getBoundingClientRect();
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width  = rect.width  + 'px';
    canvas.style.height = rect.height + 'px';
    clampCamera(camera);
    if (targetCamera) clampCamera(targetCamera);
    needsRender = true;
}

function loop() {
    // Animate camera towards target
    if (targetCamera) {
        const t = 0.13;
        camera.x    += (targetCamera.x    - camera.x)    * t;
        camera.y    += (targetCamera.y    - camera.y)    * t;
        camera.zoom += (targetCamera.zoom - camera.zoom) * t;

        if (Math.abs(targetCamera.x - camera.x) < 0.5 &&
            Math.abs(targetCamera.y - camera.y) < 0.5 &&
            Math.abs(targetCamera.zoom - camera.zoom) < 0.001) {
            Object.assign(camera, targetCamera);
            targetCamera = null;
        }
        needsRender = true;
    }

    if (needsRender) { render(); needsRender = false; }
    requestAnimationFrame(loop);
}

// ═════════════════════════════════════════════════════
//  CANVAS — MAIN RENDER
// ═════════════════════════════════════════════════════

function render() {
    // Clear (transparent so CSS grid background shows through)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Apply DPR + camera
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    drawLanes(ctx);
    drawEdges(ctx);
    drawNodes(ctx);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ─── Lanes ───────────────────────────────────────────

function drawLanes(c) {
    for (const cat of CATEGORIES) {
        const lane = laneInfo[cat];
        const col  = COLORS[cat];
        if (!lane) continue;

        // Tinted background band
        c.fillStyle = `rgba(${col.r},${col.g},${col.b},0.022)`;
        c.fillRect(-3000, lane.yStart, 8000, lane.yEnd - lane.yStart);

        // Separator line below lane
        c.save();
        c.strokeStyle = `rgba(${col.r},${col.g},${col.b},0.06)`;
        c.lineWidth = 1;
        c.beginPath();
        const sepY = lane.yEnd + LANE_GAP / 2;
        c.moveTo(-3000, sepY);
        c.lineTo(8000, sepY);
        c.stroke();
        c.restore();

        // Large watermark label
        c.save();
        c.font = '800 34px Inter, sans-serif';
        c.fillStyle = `rgba(${col.r},${col.g},${col.b},0.05)`;
        c.textAlign = 'left';
        c.textBaseline = 'middle';
        c.fillText(cat.toUpperCase(), LABEL_X, lane.midY);
        c.restore();
    }

    // Tier column headers
    for (let t = 1; t <= 6; t++) {
        const x = START_X + (t - 1) * TIER_SPACING + NODE_W / 2;
        c.save();
        c.font = '700 10px Inter, sans-serif';
        c.fillStyle = 'rgba(255,255,255,0.06)';
        c.textAlign = 'center';
        c.textBaseline = 'bottom';
        c.fillText(`TIER ${t}`, x, (laneInfo.Push?.yStart ?? 0) - 8);
        c.restore();
    }
}

// ─── Edges ───────────────────────────────────────────

function drawEdges(c) {
    const hasHover = hoveredNode != null;

    for (const edge of edgeList) {
        const fp = nodePositions[edge.from];
        const tp = nodePositions[edge.to];
        if (!fp || !tp) continue;

        const fromState = getNodeState(edge.from);
        const toState   = getNodeState(edge.to);
        const fromEx    = exerciseMap[edge.from];
        const connectedToHover = hasHover &&
            (edge.from === hoveredNode || edge.to === hoveredNode);

        c.save();

        // Dim non-connected edges when hovering
        if (hasHover && !connectedToHover) c.globalAlpha = 0.06;

        // Style
        const col = COLORS[fromEx.category];
        if (fromState === 'completed' && toState !== 'locked') {
            c.strokeStyle = `rgba(${col.r},${col.g},${col.b},0.55)`;
            c.lineWidth = 2.5;
            if (connectedToHover) {
                c.shadowColor = `rgb(${col.r},${col.g},${col.b})`;
                c.shadowBlur = 10;
            }
        } else {
            c.strokeStyle = `rgba(255,255,255,${fromState === 'completed' ? 0.1 : 0.055})`;
            c.lineWidth = 1.2;
        }

        // Determine edge geometry
        const sameColumn = Math.abs(fp.x - tp.x) < 10;

        if (sameColumn) {
            // Vertical connector (same tier)
            const goingDown = tp.y > fp.y;
            const sx = fp.x + fp.w * 0.62;
            const sy = goingDown ? fp.y + fp.h : fp.y;
            const ex = tp.x + tp.w * 0.62;
            const ey = goingDown ? tp.y : tp.y + tp.h;

            c.beginPath();
            c.moveTo(sx, sy);
            const midY = (sy + ey) / 2;
            c.quadraticCurveTo(sx + 22, midY, ex, ey);
            c.stroke();

            // Arrowhead
            c.fillStyle = c.strokeStyle;
            const dir = goingDown ? 1 : -1;
            c.beginPath();
            c.moveTo(ex, ey);
            c.lineTo(ex - 4, ey - 7 * dir);
            c.lineTo(ex + 4, ey - 7 * dir);
            c.closePath();
            c.fill();
        } else {
            // Horizontal Bézier
            const x1 = fp.x + fp.w;
            const y1 = fp.y + fp.h / 2;
            const x2 = tp.x;
            const y2 = tp.y + tp.h / 2;
            const cpOff = Math.max(Math.abs(x2 - x1) * 0.38, 45);

            c.beginPath();
            c.moveTo(x1, y1);
            c.bezierCurveTo(x1 + cpOff, y1, x2 - cpOff, y2, x2, y2);
            c.stroke();

            // Right-pointing arrowhead
            c.fillStyle = c.strokeStyle;
            c.beginPath();
            c.moveTo(x2, y2);
            c.lineTo(x2 - 7, y2 - 3.5);
            c.lineTo(x2 - 7, y2 + 3.5);
            c.closePath();
            c.fill();
        }

        c.restore();
    }
}

// ─── Nodes ───────────────────────────────────────────

function drawNodes(c) {
    const hasHover = hoveredNode != null;

    for (const ex of exercises) {
        const pos = nodePositions[ex.id];
        if (!pos) continue;

        const state   = getNodeState(ex.id);
        const hovered = hoveredNode === ex.id;
        const selected = selectedNode === ex.id;
        const connected = hasHover && isConnectedTo(hoveredNode, ex.id);
        const dimmed  = hasHover && !hovered && !connected;

        drawSingleNode(c, ex, pos, state, hovered, selected, dimmed);
    }
}

function drawSingleNode(c, ex, pos, state, hovered, selected, dimmed) {
    const { x, y, w, h } = pos;
    const col = COLORS[ex.category];

    c.save();
    if (dimmed) c.globalAlpha = 0.13;

    // Colours by state
    let bg, border, text, glow = null;
    switch (state) {
        case 'locked':
            bg     = 'rgba(18,22,36,0.7)';
            border = 'rgba(255,255,255,0.05)';
            text   = 'rgba(255,255,255,0.22)';
            break;
        case 'available':
            bg     = `rgba(${col.r},${col.g},${col.b},0.10)`;
            border = `rgba(${col.r},${col.g},${col.b},0.45)`;
            text   = 'rgba(255,255,255,0.88)';
            break;
        case 'completed':
            bg     = `rgba(${col.r},${col.g},${col.b},0.20)`;
            border = `rgb(${col.r},${col.g},${col.b})`;
            text   = '#ffffff';
            glow   = `rgb(${col.r},${col.g},${col.b})`;
            break;
    }

    if (hovered || selected) {
        border = `rgb(${col.r},${col.g},${col.b})`;
        bg     = `rgba(${col.r},${col.g},${col.b},0.16)`;
        text   = '#ffffff';
        glow   = `rgb(${col.r},${col.g},${col.b})`;
    }

    // Glow
    if (glow && !dimmed) {
        c.shadowColor = glow;
        c.shadowBlur = hovered ? 22 : 10;
    }

    // Shape
    c.beginPath();
    if (ex.type === 'balance')    hexPath(c, x, y, w, h);
    else if (ex.type === 'static') rrPath(c, x, y, w, h, 5);
    else                           rrPath(c, x, y, w, h, h / 2); // pill

    c.fillStyle = bg;
    c.fill();

    c.shadowBlur = 0;
    c.strokeStyle = border;
    c.lineWidth = (hovered || selected) ? 2 : 1.4;
    c.stroke();

    // Label text
    c.fillStyle = text;
    c.font = `${state === 'completed' ? 600 : 500} 11.5px Inter, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    wrapText(c, ex.name, x + w / 2, y + h / 2, w - 20, 14);

    // Completed badge
    if (state === 'completed') {
        const bx = x + w - 11, by = y + 11;
        c.beginPath();
        c.arc(bx, by, 7, 0, Math.PI * 2);
        c.fillStyle = `rgb(${col.r},${col.g},${col.b})`;
        c.fill();
        c.fillStyle = '#080c14';
        c.font = 'bold 9px Inter, sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('✓', bx, by + 0.5);
    }

    c.restore();
}

// ─── Shape Helpers ───────────────────────────────────

/** Rounded-rectangle subpath */
function rrPath(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
}

/** Hexagon subpath */
function hexPath(c, x, y, w, h) {
    const cx = x + w / 2, cy = y + h / 2;
    const rx = w / 2, ry = h / 2;
    for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + i * Math.PI / 3;
        const px = cx + rx * Math.cos(a);
        const py = cy + ry * Math.sin(a);
        i === 0 ? c.moveTo(px, py) : c.lineTo(px, py);
    }
    c.closePath();
}

/** Draw text, wrapping to a second line if needed */
function wrapText(c, str, x, y, maxW, lineH) {
    const words = str.split(' ');
    let line = '';
    const lines = [];
    for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (c.measureText(test).width > maxW && line) {
            lines.push(line);
            line = w;
        } else {
            line = test;
        }
    }
    lines.push(line);
    const startY = y - (lines.length - 1) * lineH / 2;
    lines.forEach((l, i) => c.fillText(l, x, startY + i * lineH));
}

// ═════════════════════════════════════════════════════
//  HIT TESTING & HELPERS
// ═════════════════════════════════════════════════════

function screenToWorld(sx, sy) {
    return {
        x: (sx - camera.x) / camera.zoom,
        y: (sy - camera.y) / camera.zoom,
    };
}

function hitTest(wx, wy) {
    for (let i = exercises.length - 1; i >= 0; i--) {
        const p = nodePositions[exercises[i].id];
        if (p && wx >= p.x && wx <= p.x + p.w && wy >= p.y && wy <= p.y + p.h)
            return exercises[i].id;
    }
    return null;
}

function isConnectedTo(a, b) {
    if (!a || !b) return false;
    const ea = exerciseMap[a], eb = exerciseMap[b];
    if (!ea || !eb) return false;
    return ea.unlocks?.includes(b) || ea.prerequisites?.includes(b) ||
           eb.unlocks?.includes(a) || eb.prerequisites?.includes(a);
}

// ═════════════════════════════════════════════════════
//  CANVAS INTERACTION (mouse + touch)
// ═════════════════════════════════════════════════════

function setupCanvasEvents() {
    window.addEventListener('resize', () => { resizeCanvas(); needsRender = true; });

    // ── Mouse ──
    canvas.addEventListener('mousedown', e => {
        isDragging = true;
        dragStart = { x: e.clientX, y: e.clientY };
        dragCameraStart = { x: camera.x, y: camera.y };
        targetCamera = null;
        document.getElementById('canvas-hint')?.classList.add('fade');
    });

    canvas.addEventListener('mousemove', e => {
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

        if (isDragging) {
            camera.x = dragCameraStart.x + (e.clientX - dragStart.x);
            camera.y = dragCameraStart.y + (e.clientY - dragStart.y);
            clampCamera(camera);
            needsRender = true;
            return;
        }

        const w = screenToWorld(sx, sy);
        const hit = hitTest(w.x, w.y);
        if (hit !== hoveredNode) {
            hoveredNode = hit;
            canvas.style.cursor = hit ? 'pointer' : 'grab';
            needsRender = true;
        }
    });

    canvas.addEventListener('mouseup', () => { isDragging = false; });
    canvas.addEventListener('mouseleave', () => {
        isDragging = false;
        if (hoveredNode) { hoveredNode = null; needsRender = true; }
    });

    canvas.addEventListener('click', e => {
        if (Math.abs(e.clientX - dragStart.x) > 5 ||
            Math.abs(e.clientY - dragStart.y) > 5) return; // was a drag

        const rect = canvas.getBoundingClientRect();
        const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
        const hit = hitTest(w.x, w.y);

        if (hit) { selectedNode = hit; showPanel(hit); needsRender = true; }
        else if (selectedNode) { hidePanel(); }
    });

    canvas.addEventListener('wheel', e => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const factor = e.deltaY > 0 ? 0.92 : 1.08;
        const nz = Math.max(0.35, Math.min(3.5, camera.zoom * factor));
        camera.x = mx - (mx - camera.x) * (nz / camera.zoom);
        camera.y = my - (my - camera.y) * (nz / camera.zoom);
        camera.zoom = nz;
        clampCamera(camera);
        targetCamera = null;
        needsRender = true;
    }, { passive: false });

    // ── Touch ──
    let lastDist = 0, lastMid = { x: 0, y: 0 };

    canvas.addEventListener('touchstart', e => {
        e.preventDefault();
        if (e.touches.length === 1) {
            isDragging = true;
            const t = e.touches[0];
            dragStart = { x: t.clientX, y: t.clientY };
            dragCameraStart = { x: camera.x, y: camera.y };
            targetCamera = null;
        } else if (e.touches.length === 2) {
            isDragging = false;
            const [a, b] = [e.touches[0], e.touches[1]];
            lastDist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
            lastMid  = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', e => {
        e.preventDefault();
        if (e.touches.length === 1 && isDragging) {
            const t = e.touches[0];
            camera.x = dragCameraStart.x + (t.clientX - dragStart.x);
            camera.y = dragCameraStart.y + (t.clientY - dragStart.y);
            clampCamera(camera);
            needsRender = true;
        } else if (e.touches.length === 2) {
            const [a, b] = [e.touches[0], e.touches[1]];
            const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
            const mid  = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
            const rect = canvas.getBoundingClientRect();
            const mx = mid.x - rect.left, my = mid.y - rect.top;
            const nz = Math.max(0.35, Math.min(3.5, camera.zoom * (dist / lastDist)));
            camera.x = mx - (mx - camera.x) * (nz / camera.zoom) + (mid.x - lastMid.x);
            camera.y = my - (my - camera.y) * (nz / camera.zoom) + (mid.y - lastMid.y);
            camera.zoom = nz;
            clampCamera(camera);
            lastDist = dist;
            lastMid = mid;
            needsRender = true;
        }
    }, { passive: false });

    canvas.addEventListener('touchend', e => {
        if (e.touches.length === 0 && isDragging) {
            const t = e.changedTouches[0];
            if (Math.abs(t.clientX - dragStart.x) < 12 &&
                Math.abs(t.clientY - dragStart.y) < 12) {
                const rect = canvas.getBoundingClientRect();
                const w = screenToWorld(t.clientX - rect.left, t.clientY - rect.top);
                const hit = hitTest(w.x, w.y);
                if (hit) { selectedNode = hit; showPanel(hit); needsRender = true; }
            }
            isDragging = false;
        }
    });

    canvas.addEventListener('contextmenu', e => e.preventDefault());
}

// ═════════════════════════════════════════════════════
//  CAMERA CONTROLS
// ═════════════════════════════════════════════════════

function fitAll(animate) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of Object.values(nodePositions)) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + p.w);
        maxY = Math.max(maxY, p.y + p.h);
    }
    if (minX === Infinity) return;

    const pad = 50;
    const rect = canvas.getBoundingClientRect();
    const vw = rect.width, vh = rect.height;
    const tw = maxX - minX, th = maxY - minY;
    const zoom = Math.min((vw - pad * 2) / tw, (vh - pad * 2) / th, 1.4);
    const cx = minX + tw / 2, cy = minY + th / 2;

    const cam = { x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom, zoom };
    clampCamera(cam);
    if (animate) targetCamera = cam;
    else { Object.assign(camera, cam); needsRender = true; }
}

function focusNode(id, animate = true) {
    const p = nodePositions[id];
    if (!p) return;
    const rect = canvas.getBoundingClientRect();
    const panelW = document.getElementById('detail-panel').classList.contains('hidden') ? 0 : 370;
    const vw = rect.width - panelW, vh = rect.height;
    const zoom = Math.max(camera.zoom, 0.85);
    const cam = { x: vw / 2 - (p.x + p.w / 2) * zoom, y: vh / 2 - (p.y + p.h / 2) * zoom, zoom };
    clampCamera(cam);
    if (animate) targetCamera = cam;
    else { Object.assign(camera, cam); needsRender = true; }
}

// ═════════════════════════════════════════════════════
//  UI — DETAIL PANEL
// ═════════════════════════════════════════════════════

function showPanel(id) {
    const ex = exerciseMap[id];
    if (!ex) return;
    selectedNode = id;

    const col = COLORS[ex.category];
    const state = getNodeState(id);
    const panel = document.getElementById('detail-panel');

    // Accent
    document.getElementById('panel-accent-bar').style.background =
        `rgb(${col.r},${col.g},${col.b})`;

    // Header
    document.getElementById('detail-title').textContent = ex.name;

    const catB = document.getElementById('detail-category');
    catB.textContent = ex.category;
    catB.style.setProperty('--cat-color', `rgb(${col.r},${col.g},${col.b})`);
    catB.style.setProperty('--cat-bg', `rgba(${col.r},${col.g},${col.b},0.12)`);

    document.getElementById('detail-type').textContent = ex.type;
    document.getElementById('detail-tier').textContent = 'Tier ' + (ex.tier || 1);
    document.getElementById('detail-desc').textContent = ex.description;

    // Prerequisites
    fillBadgeList('prereq-section', 'detail-prereqs', ex.prerequisites, true);

    // Unlocks
    fillBadgeList('unlocks-section', 'detail-unlocks', ex.unlocks, true);

    // Drills
    const drillSec = document.getElementById('drills-section');
    const drillBox = document.getElementById('detail-drills');
    drillBox.innerHTML = '';
    if (ex.drills?.length) {
        ex.drills.forEach(d => {
            const s = document.createElement('span');
            s.className = 'drill-tag';
            s.textContent = d;
            drillBox.appendChild(s);
        });
        drillSec.classList.remove('hidden');
    } else {
        drillSec.classList.add('hidden');
    }

    // Complete button
    const btn  = document.getElementById('toggle-complete-btn');
    const text = document.getElementById('complete-btn-text');
    btn.className = 'complete-btn';
    if (state === 'completed') {
        btn.classList.add('is-completed');
        text.textContent = 'Completed ✓';
    } else if (state === 'locked') {
        btn.classList.add('is-locked');
        text.textContent = 'Locked — complete prerequisites';
    } else {
        text.textContent = 'Mark Complete';
    }

    panel.classList.remove('hidden');
    needsRender = true;
}

function fillBadgeList(sectionId, containerId, ids, clickable) {
    const sec = document.getElementById(sectionId);
    const box = document.getElementById(containerId);
    box.innerHTML = '';
    if (ids?.length) {
        ids.forEach(pid => {
            const pEx = exerciseMap[pid];
            if (!pEx) return;
            if (clickable) {
                const btn = document.createElement('button');
                btn.className = 'skill-link';
                btn.textContent = pEx.name;
                btn.addEventListener('click', () => {
                    selectedNode = pid;
                    showPanel(pid);
                    focusNode(pid);
                    needsRender = true;
                });
                box.appendChild(btn);
            } else {
                const s = document.createElement('span');
                s.className = 'drill-tag';
                s.textContent = pEx.name;
                box.appendChild(s);
            }
        });
        sec.classList.remove('hidden');
    } else {
        sec.classList.add('hidden');
    }
}

function hidePanel() {
    document.getElementById('detail-panel').classList.add('hidden');
    selectedNode = null;
    needsRender = true;
}

// ═════════════════════════════════════════════════════
//  UI — TOAST
// ═════════════════════════════════════════════════════

function showToast(msg) {
    const box = document.getElementById('toast-container');
    const el  = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3200);
}

// ═════════════════════════════════════════════════════
//  UI — SEARCH
// ═════════════════════════════════════════════════════

function setupSearch() {
    const input   = document.getElementById('search-input');
    const results = document.getElementById('search-results');

    input.addEventListener('input', () => {
        const q = input.value.toLowerCase().trim();
        results.innerHTML = '';
        if (!q) { results.classList.remove('active'); return; }

        const hits = exercises.filter(e => e.name.toLowerCase().includes(q)).slice(0, 8);
        if (!hits.length) { results.classList.remove('active'); return; }

        hits.forEach(ex => {
            const li = document.createElement('li');
            const col = COLORS[ex.category];
            li.innerHTML =
                `<span class="result-dot" style="background:rgb(${col.r},${col.g},${col.b})"></span>` +
                `<span class="result-name">${ex.name}</span>` +
                `<span class="result-cat">${ex.category}</span>`;
            li.addEventListener('click', () => {
                selectedNode = ex.id;
                showPanel(ex.id);
                focusNode(ex.id);
                input.value = '';
                results.innerHTML = '';
                results.classList.remove('active');
                needsRender = true;
            });
            results.appendChild(li);
        });
        results.classList.add('active');
    });

    document.addEventListener('click', e => {
        if (!e.target.closest('#search-wrapper')) results.classList.remove('active');
    });
    input.addEventListener('keydown', e => {
        if (e.key === 'Escape') { input.value = ''; results.classList.remove('active'); input.blur(); }
    });
}

// ═════════════════════════════════════════════════════
//  UI — TOOLBAR & KEYBOARD
// ═════════════════════════════════════════════════════

function setupUIEvents() {
    document.getElementById('close-panel').addEventListener('click', hidePanel);

    document.getElementById('toggle-complete-btn').addEventListener('click', () => {
        if (selectedNode) toggleComplete(selectedNode);
    });

    document.getElementById('legend-btn').addEventListener('click', () => {
        document.getElementById('legend-panel').classList.toggle('hidden');
    });

    document.getElementById('reset-btn').addEventListener('click', () => fitAll(true));
    document.getElementById('clear-progress-btn').addEventListener('click', () => {
        if (confirm("Are you sure you want to completely wipe all your progress? This cannot be undone.")) {
            completed.clear();
            saveProgress();
            updateNodeStates();
            updateProgressUI();
            closeDetailPanel();
            showToast("All progress wiped", "var(--color-push)");
        }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && selectedNode) hidePanel();
    });
}

// ═════════════════════════════════════════════════════
//  BOOT
// ═════════════════════════════════════════════════════
init();

})();