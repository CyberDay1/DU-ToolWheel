// Tool Wheel: client side. Injected into the HUD view by the ToolWheel server mod through the
// "modinjectjs" HUD event, which eval()s this text. The server replaces the two
// __TOOLWHEEL_*__ placeholders before sending.
//
// Written for the HUD's older JavaScript engine: ES6 classes are fine (the toolkit's own sample
// uses them); no optional chaining, no "??".
//
// Console output goes to the client log (%LOCALAPPDATA%\NQ\myDU\log\log_*.xml) as
// "ConsoleAPI" lines. Every line from this script starts with [ToolWheel]. Lines marked
// [unproven] cover behaviour not yet confirmed in game.
(function () {
  "use strict";
  var CFG = __TOOLWHEEL_CONFIG__;
  var VERSION = "__TOOLWHEEL_VERSION__";
  var MOD = "ToolWheel";
  var A_HELLO = 100, A_DATA = 101, A_LOG = 102, A_HOTKEY = 103;
  var TAG = "[ToolWheel] ";
  var BAR_SLOTS = 9;

  // ---------------------------------------------------------------- logging
  var debug = !!CFG.debug;

  function forward(line) {
    try { CPPMod.sendModAction(MOD, A_LOG, [], line); } catch (e) { }
  }
  // Always logged: load, open/close, selection and its result.
  function log(msg) {
    try { console.log(TAG + msg); } catch (e) { }
    if (debug) forward(msg);
  }
  // Debug only: key events, engine traffic, probes.
  function dbg(msg) {
    if (!debug) return;
    try { console.log(TAG + "[debug] " + msg); } catch (e) { }
    forward("[debug] " + msg);
  }
  function short(v, n) {
    var s;
    try { s = typeof v === "string" ? v : JSON.stringify(v); } catch (e) { s = String(v); }
    if (s === undefined) s = String(v);
    n = n || 300;
    return s.length > n ? s.substring(0, n) + "..." : s;
  }
  function argsOf(a) {
    var out = [];
    for (var i = 0; i < a.length; i++) out.push(short(a[i], 200));
    return "(" + out.join(", ") + ")";
  }
  function send(id, payload) {
    try { CPPMod.sendModAction(MOD, id, [], payload || ""); return true; }
    catch (e) { try { console.error(TAG + "CPPMod.sendModAction failed: " + e); } catch (e2) { } return false; }
  }
  // Every toolBar call the wheel makes goes through tb(), so the binding trace (debug) can tell
  // the wheel's own calls from the stock UI's.
  var ownCall = 0;
  function tb(name) {
    var a = Array.prototype.slice.call(arguments, 1);
    ownCall++;
    try { return toolBar[name].apply(toolBar, a); } finally { ownCall--; }
  }

  // ---------------------------------------------------------------- single instance
  // One live copy per HUD view. The same version re-sent is a no-op; a different one disposes
  // the old copy (listeners, timers, DOM) and takes over. Every handler also checks that its
  // own state is still window.__toolWheel, so a copy whose dispose failed goes inert anyway.
  var INSTANCE = VERSION + "-" + Math.floor(Math.random() * 0x10000).toString(16);
  var prev = window.__toolWheel;
  if (prev && prev.version === VERSION && !prev.disposed) {
    log("already loaded (v" + VERSION + ", instance " + prev.instance + "), confirming again");
    prev.hello("reinject");
    return;
  }
  if (prev) {
    var prevId = prev.instance || ("v" + prev.version);
    try { if (typeof prev.dispose === "function") prev.dispose(); else prev.disposed = true; }
    catch (e) { prev.disposed = true; log("instance " + prevId + " threw while disposing: " + e); }
    log("instance " + INSTANCE + " took over from " + prevId);
  }

  var state = {
    version: VERSION,
    instance: INSTANCE,
    disposed: false,
    tools: { explore: [], build: [] },  // owned tools per group, from the server
    serverBars: { explore: [], build: [] },
    source: "none",
    live: [],               // live stock bar: type id (string) per slot, "" = empty
    liveKnown: false,
    mode: null,             // "explore" | "build": the game's mode, see detectMode
    modeHow: null,
    mouseMode: null,        // HudManager.SetEnhancedMouse
    toggledMouse: false,
    open: false,
    hover: -1,
    busy: false,
    keyDown: false,
    keyDownAt: 0,
    openedByKey: false,
    selectedSlot: -1,
    lastSelectEventAt: 0,
    ownSelectUntil: 0,      // selections the wheel itself makes are not undone by the key guard
    keyGuard: null,         // { prior, at, until, code }: see "slot-key guard"
    quickGuard: null,       // { key, code, tool, at, until, stock, timer }: see "quick-select keys"
    contentEvents: [],      // recent SetContentOfToolBar(slot, typeId)
    pending: null,          // the toolbar event a pick is waiting for: see await_
    busySince: 0,
    dataWaiters: [],        // refreshTools callbacks, run on the next ToolWheel.data
  };
  window.__toolWheel = state;
  function live() {
    if (state.disposed) return false;
    if (window.__toolWheel !== state) { try { state.dispose(); } catch (e) { state.disposed = true; } return false; }
    return true;
  }

  function on(name, fn) {
    try {
      engine.on(name, function () {
        if (!live()) return;
        try { fn.apply(null, arguments); } catch (e) { log("handler " + name + " threw: " + e); }
      });
      return true;
    } catch (e) { log("engine.on(" + name + ") failed: " + e); return false; }
  }

  // ---------------------------------------------------------------- DOM helpers
  function el(parent, tag, style, text) {
    var n = document.createElement(tag);
    if (style) css(n, style);
    if (text !== undefined) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function css(n, style) {
    for (var k in style) if (Object.prototype.hasOwnProperty.call(style, k) && style[k] !== undefined) n.style[k] = style[k];
  }
  function cls(n) { return typeof n.className === "string" ? n.className : ""; }
  function describe(n) {
    if (!n) return "none";
    var c = cls(n);
    return n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (c ? "." + c.trim().split(/\s+/).join(".") : "");
  }

  // ---------------------------------------------------------------- look (design A, true radial)
  // Every size is in 4K pixels (the mockup, mockups/A_true_radial.html) and is scaled by
  // k = window.innerHeight / 2160 at open. px only: vh is double-scaled in Coherent views.
  // Stock visual language: sharp corners, thin cyan-white lines, dark translucent panels.
  // No glow, no gradients, no animation.
  var LOOK = {
    line: "rgba(200, 228, 240, 0.24)", lineHi: "rgba(222, 240, 248, 0.9)", hubLine: "rgba(200, 228, 240, 0.34)",
    panel: "rgba(9, 13, 17, 0.80)", hub: "rgba(7, 10, 13, 0.88)", hover: "rgba(196, 230, 244, 0.15)",
    text: "rgb(222, 236, 242)", dim: "rgba(222, 236, 242, 0.58)", label: "rgba(222, 236, 242, 0.62)",
    solid: "rgb(216, 238, 246)", backdrop: "rgba(3, 6, 9, 0.42)",
    RO: 600, RI: 336, GAP: 8, HUB: 304, ICON_R: 470, ICON: 112,
    iconBase: "coui://data/resources_generated/iconsLib/misclib/",
  };
  var k = 1, iconBase = LOOK.iconBase;
  function S(v) { return Math.round(v * k * 100) / 100; }
  function cs(n) { try { return n ? window.getComputedStyle(n) : null; } catch (e) { return null; } }

  // Icon base: wherever the stock bar loads its icons from.
  function readIconBase() {
    var ab = document.getElementById("action_bar");
    if (!ab) return;
    var imgs = ab.getElementsByTagName("img");
    for (var j = 0; j < imgs.length; j++) {
      var src = imgs[j].getAttribute("src") || "", q = src.indexOf("iconsLib/");
      if (q >= 0) { iconBase = src.substring(0, q) + "iconsLib/misclib/"; return; }
    }
    var nodes = ab.getElementsByTagName("*");
    for (var m = 0; m < nodes.length; m++) {
      var bg = (cs(nodes[m]) || {}).backgroundImage || "", q2 = bg.indexOf("iconsLib/");
      if (q2 >= 0) { iconBase = bg.substring(bg.indexOf("(") + 1, q2).replace(/["']/g, "") + "iconsLib/misclib/"; return; }
    }
  }

  // ---------------------------------------------------------------- quick-select keys
  // QuickKeys (server config): one key per wedge in wheel order, 1 2 3 4 5 6 7 8 9 0 - = by
  // default, so a tool keeps its key as long as the wheel order stays the same. code 0 = that
  // wedge has no key. Same lookup as ToolWheelConfig.QuickKeyIndex (tested there): digits also
  // match the numpad (96-105), "-" also 173 and "=" also 61 (codes some engines send).
  var QUICK = (CFG.quickKeys || []).map(function (q) { return { label: String(q.label), code: q.code | 0 }; });
  function quickIndex(c, n) {
    for (var i = 0; i < QUICK.length && i < n; i++) {
      var q = QUICK[i].code;
      if (q <= 0) continue;
      if (q === c || (q >= 48 && q <= 57 && c === q + 48) || (q === 189 && c === 173) || (q === 187 && c === 61)) return i;
    }
    return -1;
  }
  function quickLabel(i) { return i >= 0 && i < QUICK.length && QUICK[i].code > 0 ? QUICK[i].label : null; }

  // ---------------------------------------------------------------- font
  // Fix 1 of the README plan. The family is read from a stock element that renders text and
  // copied verbatim; a probe string measured in it and in a family that cannot exist proves
  // the face loaded (equal widths = it did not, so the next candidate is tried).
  var font = null; // { family, from, w, base }
  function measure(family) {
    var s = el(document.body, "span", {
      position: "absolute", left: "-10000px", top: "0px", fontSize: "40px", whiteSpace: "nowrap",
      fontFamily: family, visibility: "hidden",
    }, "WMWMiiii");
    var w = s.offsetWidth;
    s.parentNode.removeChild(s);
    return w;
  }
  function ownText(n) {
    for (var c = n.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && /\S/.test(c.nodeValue)) return true;
    return false;
  }
  function firstTextIn(scope, limit) {
    if (!scope) return null;
    var all = scope.getElementsByTagName("*");
    for (var i = 0; i < all.length && i < limit; i++) {
      if (!root.contains(all[i]) && ownText(all[i]) && !/^(SCRIPT|STYLE)$/i.test(all[i].tagName)) return all[i];
    }
    return null;
  }
  function pickFont() {
    var cands = [], seen = {};
    function add(n, label) {
      var c = cs(n);
      if (!c || !c.fontFamily || seen[c.fontFamily]) return;
      seen[c.fontFamily] = true;
      cands.push({ family: c.fontFamily, from: label + " " + describe(n) });
    }
    try { add(document.querySelector(".context_menu ul li a"), "context menu entry"); } catch (e) { }
    try { add(document.querySelector("#action_bar .active_container_name"), "hotbar name"); } catch (e) { }
    add(firstTextIn(document.getElementById("action_bar"), 400), "hotbar text");
    add(firstTextIn(document.body, 4000), "first HUD text");
    var base = measure("ToolWheelNoSuchFace");
    for (var i = 0; i < cands.length; i++) {
      var w = measure(cands[i].family);
      var loaded = w > 0 && w !== base;
      log("font: candidate " + JSON.stringify(cands[i].family) + " from " + cands[i].from + ": probe " + w +
        "px vs missing-face " + base + "px, " + (loaded ? "loaded" : "NOT loaded"));
      if (loaded) { cands[i].w = w; cands[i].base = base; return cands[i]; }
    }
    log("font: no stock family measured as loaded (" + cands.length + " candidate(s)); the engine default font is used");
    return cands.length ? { family: cands[0].family, from: cands[0].from + " (unverified)", w: 0, base: base } : null;
  }

  // ---------------------------------------------------------------- wheel DOM
  var root = el(document.body, "div", {
    position: "absolute", left: "0px", top: "0px", width: "100%", height: "100%",
    zIndex: "9000", display: "none", backgroundColor: LOOK.backdrop, overflow: "hidden",
  });
  root.id = "toolwheel_root";
  var drawMode = null, canvas = null, ctx = null, svg = null;
  var nodes = { icons: [], labels: [], keys: [] };
  var hubNode = el(root, "div", { position: "absolute", textAlign: "center" });
  var hHdr = el(hubNode, "div", {});
  var hRule = el(hubNode, "div", {});
  var hName = el(hubNode, "div", {});
  var hDesc = el(hubNode, "div", {});
  var hSlot = el(hubNode, "div", {});
  var hHot = el(hubNode, "div", {}); // the hotkey and its Change button, or the change prompt's buttons
  var hints = el(root, "div", { position: "absolute", left: "0px", right: "0px", textAlign: "center" });
  var geo = { cx: 0, cy: 0, size: 0, n: 0 };

  function initDraw() {
    if (drawMode) return;
    try {
      var c = document.createElement("canvas");
      var x = c.getContext ? c.getContext("2d") : null;
      if (x && typeof x.arc === "function") { canvas = c; ctx = x; drawMode = "canvas"; }
    } catch (e) { dbg("canvas 2d probe threw " + e); }
    if (!drawMode) {
      try {
        svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        drawMode = "svg";
      } catch (e) { drawMode = "none"; }
    }
    var surface = canvas || svg;
    if (surface) {
      surface.style.position = "absolute";
      root.insertBefore(surface, root.firstChild);
    }
    log("[unproven] wheel drawn with " + (drawMode === "canvas" ? "canvas 2d" : drawMode === "svg" ? "svg (canvas 2d unavailable)" : "nothing (no canvas, no svg)"));
  }

  // The game's mode decides the group: build tools only in build mode, roaming tools outside it.
  function groupNow() {
    return state.mode || (CFG.defaultBar === "build" ? "build" : "explore");
  }
  function toolsNow() { return state.tools[groupNow()] || []; }
  function liveSlotOf(id) {
    for (var i = 0; i < state.live.length; i++) if (state.live[i] === id) return i;
    return -1;
  }
  function equippedIndex(list) {
    if (state.selectedSlot < 0) return -1;
    for (var i = 0; i < list.length; i++) if (liveSlotOf(list[i].id) === state.selectedSlot) return i;
    return -1;
  }

  // Raises the wheel above the HUD's own layers (nameplates included) so the backdrop hides them.
  function zAbove() {
    var top = 9000, kids = document.body.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] === root) continue;
      var z = parseInt((cs(kids[i]) || {}).zIndex, 10);
      if (!isNaN(z) && z >= top) top = z + 1;
    }
    root.style.zIndex = String(top);
    return top;
  }

  function layout() {
    var W = window.innerWidth || 1920, H = window.innerHeight || 1080;
    k = H / 2160;
    readIconBase();
    initDraw();
    if (!font || !font.w) font = pickFont();
    var z = zAbove();
    dbg("scale: innerWidth " + W + ", innerHeight " + H + ", devicePixelRatio " + window.devicePixelRatio +
      ", k " + k.toFixed(3) + "; html font-size " + ((cs(document.documentElement) || {}).fontSize) + "; z-index " + z +
      "; icons from " + iconBase);
    css(root, { fontFamily: font ? font.family : "", color: LOOK.text });
    var size = Math.ceil(S(LOOK.RO + 40)) * 2;
    geo = { cx: W / 2, cy: H / 2, size: size };
    var surface = canvas || svg;
    if (surface) {
      css(surface, { left: (geo.cx - size / 2) + "px", top: (geo.cy - size / 2) + "px", width: size + "px", height: size + "px" });
      if (canvas) {
        var dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      } else {
        svg.setAttribute("width", size); svg.setAttribute("height", size);
      }
    }
    css(hubNode, { width: S(420) + "px", left: (geo.cx - S(210)) + "px" });
    css(hHdr, { fontSize: S(26) + "px", letterSpacing: "0.2em", textTransform: "uppercase", color: LOOK.dim });
    css(hRule, { width: S(96) + "px", height: Math.max(1, S(2)) + "px", backgroundColor: LOOK.line, margin: S(22) + "px auto " + S(24) + "px auto" });
    css(hName, { fontSize: S(56) + "px", fontWeight: "700", letterSpacing: "0.04em", textTransform: "uppercase", lineHeight: "1.05" });
    css(hDesc, { fontSize: S(30) + "px", color: LOOK.dim, marginTop: S(16) + "px", lineHeight: "1.3" });
    css(hSlot, { fontSize: S(24) + "px", letterSpacing: "0.14em", textTransform: "uppercase", color: LOOK.dim, marginTop: S(26) + "px" });
    css(hHot, { fontSize: S(22) + "px", letterSpacing: "0.14em", textTransform: "uppercase", color: LOOK.dim, marginTop: S(30) + "px" });
    css(hints, { top: (geo.cy + S(710)) + "px", fontSize: S(26) + "px", letterSpacing: "0.12em", textTransform: "uppercase", color: LOOK.dim });
    hints.innerHTML = "";
    var hintRows = [["LMB", "Equip"]], nk = 0;
    for (var q = 0; q < toolsNow().length; q++) if (quickLabel(q) !== null) nk = q + 1;
    if (nk) hintRows.push([quickLabel(0) + (nk > 1 ? " \u2026 " + quickLabel(nk - 1) : ""), "Quick equip"]);
    hintRows.push(["Esc", "Close"]);
    hintRows.forEach(function (h) {
      var sp = el(hints, "span", { margin: "0px " + S(34) + "px" });
      el(sp, "span", {
        display: "inline-block", minWidth: S(30) + "px", padding: S(4) + "px " + S(12) + "px", marginRight: S(14) + "px",
        border: Math.max(1, S(2)) + "px solid " + LOOK.lineHi, color: LOOK.text, fontSize: S(22) + "px", letterSpacing: "0.06em",
      }, h[0]);
      sp.appendChild(document.createTextNode(h[1]));
    });
  }

  function P(r, deg) { var a = deg * Math.PI / 180; return [geo.size / 2 + r * Math.cos(a), geo.size / 2 + r * Math.sin(a)]; }

  // Annular sector with a constant pixel gap on both straight edges (degrees, 0 = 3 o'clock).
  function sector(r0, r1, a0, a1, gap, fill, stroke, sw) {
    var g0 = Math.asin(Math.min(1, gap / 2 / r0)) * 180 / Math.PI, g1 = Math.asin(Math.min(1, gap / 2 / r1)) * 180 / Math.PI;
    if (ctx) {
      var R = Math.PI / 180, c = geo.size / 2;
      ctx.beginPath();
      ctx.arc(c, c, r1, (a0 + g1) * R, (a1 - g1) * R, false);
      ctx.arc(c, c, r0, (a1 - g0) * R, (a0 + g0) * R, true);
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = sw; ctx.stroke(); }
    } else if (svg) {
      var p1 = P(r1, a0 + g1), p2 = P(r1, a1 - g1), p3 = P(r0, a1 - g0), p4 = P(r0, a0 + g0), big = (a1 - a0) > 180 ? 1 : 0;
      svgEl("path", {
        d: "M" + p1 + " A" + r1 + "," + r1 + " 0 " + big + " 1 " + p2 + " L" + p3 + " A" + r0 + "," + r0 + " 0 " + big + " 0 " + p4 + " Z",
        fill: fill || "none", stroke: stroke || "none", "stroke-width": sw || 0,
      });
    }
  }
  function arcLine(r, a0, a1, color, w) {
    if (ctx) {
      var R = Math.PI / 180, c = geo.size / 2;
      ctx.beginPath(); ctx.arc(c, c, r, a0 * R, a1 * R, false);
      ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke();
    } else if (svg) {
      var p1 = P(r, a0), p2 = P(r, a1);
      svgEl("path", { d: "M" + p1 + " A" + r + "," + r + " 0 0 1 " + p2, fill: "none", stroke: color, "stroke-width": w });
    }
  }
  function circle(r, fill, stroke, w) {
    if (ctx) {
      var c = geo.size / 2;
      ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2, false);
      ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = w; ctx.stroke();
    } else if (svg) {
      svgEl("circle", { cx: geo.size / 2, cy: geo.size / 2, r: r, fill: fill, stroke: stroke, "stroke-width": w });
    }
  }
  function triangle(pts, fill) {
    if (ctx) {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); ctx.lineTo(pts[2][0], pts[2][1]);
      ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    } else if (svg) {
      svgEl("path", { d: "M" + pts[0] + " L" + pts[1] + " L" + pts[2] + " Z", fill: fill });
    }
  }
  function svgEl(tag, a) {
    var n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var key in a) n.setAttribute(key, a[key]);
    svg.appendChild(n);
  }

  // Draws the wedges, hover bar, equipped tick, hub disc and pointer. Called on every hover change.
  function draw() {
    var list = toolsNow(), n = list.length, step = n ? 360 / n : 360;
    var hov = state.hover, eq = equippedIndex(list);
    if (ctx) ctx.clearRect(0, 0, geo.size, geo.size);
    if (svg) while (svg.firstChild) svg.removeChild(svg.firstChild);
    var RO = S(LOOK.RO), RI = S(LOOK.RI), GAP = S(LOOK.GAP), sw = Math.max(1, S(2));
    for (var i = 0; i < n; i++) {
      var mid = -90 + i * step, a0 = mid - step / 2, a1 = mid + step / 2, on = i === hov;
      sector(RI, RO, a0, a1, GAP, on ? LOOK.hover : LOOK.panel, on ? LOOK.lineHi : LOOK.line, sw);
      // Selection bar outside the hovered wedge: a solid band.
      if (on) sector(RO + S(12), RO + S(22), a0, a1, GAP, LOOK.solid, null, 0);
      // Equipped tool: a short solid tick on the inner edge.
      if (i === eq) arcLine(RI + S(10), mid - 6, mid + 6, LOOK.solid, Math.max(2, S(4)));
    }
    if (n === 0) sector(RI, RO, -179.9, 179.9, 0, LOOK.panel, LOOK.line, sw);
    var HUB = S(LOOK.HUB);
    circle(HUB, LOOK.hub, LOOK.hubLine, sw);
    if (hov >= 0 && n) {
      var pm = -90 + hov * step;
      triangle([P(HUB - S(2), pm - 4), P(HUB - S(2), pm + 4), P(HUB - S(22), pm)], LOOK.solid);
    }
  }

  function render() {
    var i;
    for (i = 0; i < nodes.icons.length; i++) root.removeChild(nodes.icons[i]);
    for (i = 0; i < nodes.labels.length; i++) root.removeChild(nodes.labels[i]);
    for (i = 0; i < nodes.keys.length; i++) if (nodes.keys[i]) root.removeChild(nodes.keys[i]);
    nodes = { icons: [], labels: [], keys: [] };
    var list = toolsNow(), n = list.length, step = n ? 360 / n : 360;
    var ox = geo.cx - geo.size / 2, oy = geo.cy - geo.size / 2, ICON = S(LOOK.ICON), LW = S(260);
    for (var j = 0; j < n; j++) {
      var t = list[j], mid = -90 + j * step, ic = P(S(LOOK.ICON_R), mid);
      var img = el(root, "img", {
        position: "absolute", left: (ox + ic[0] - ICON / 2) + "px", top: (oy + ic[1] - S(74)) + "px",
        width: ICON + "px", height: ICON + "px",
      });
      (function (tool, imgNode) {
        imgNode.onerror = function () { imgNode.style.visibility = "hidden"; dbg("icon missing for " + tool.name + ": " + imgNode.src); };
      })(t, img);
      img.src = iconBase + t.icon;
      nodes.icons.push(img);
      var lab = el(root, "div", {
        position: "absolute", left: (ox + ic[0] - LW / 2) + "px", width: LW + "px", top: (oy + ic[1] + S(52)) + "px",
        textAlign: "center", fontSize: S(24) + "px", letterSpacing: "0.11em", textTransform: "uppercase", whiteSpace: "nowrap",
      }, t.shortLabel || t.label);
      nodes.labels.push(lab);
      // Quick-select key cap in the wedge's leading corner (stock key-hint style: square, thin line).
      var key = quickLabel(j), cap = null;
      if (key !== null) {
        var KC = S(46), kb = Math.max(1, S(2)), kp = P(S(LOOK.RO - 42), mid - step / 2 + step * 0.2);
        cap = el(root, "div", {
          position: "absolute", left: (ox + kp[0] - KC / 2) + "px", top: (oy + kp[1] - KC / 2) + "px",
          width: KC + "px", height: KC + "px", lineHeight: (KC - 2 * kb) + "px", boxSizing: "border-box",
          border: kb + "px solid " + LOOK.line, backgroundColor: LOOK.hub,
          textAlign: "center", fontSize: S(26) + "px", fontWeight: "700", color: LOOK.label,
        }, key);
      }
      nodes.keys.push(cap);
    }
    setHover(state.hover < n ? state.hover : -1, true);
  }

  function setHover(i, force) {
    if (i === state.hover && !force) return;
    state.hover = i;
    var list = toolsNow();
    for (var m = 0; m < nodes.icons.length; m++) {
      nodes.icons[m].style.opacity = m === i ? "1" : "0.82";
      nodes.labels[m].style.color = m === i ? LOOK.text : LOOK.label;
      if (nodes.keys[m]) {
        nodes.keys[m].style.borderColor = m === i ? LOOK.lineHi : LOOK.line;
        nodes.keys[m].style.color = m === i ? LOOK.text : LOOK.label;
      }
    }
    draw();
    hHdr.textContent = groupNow() === "build" ? "Build tools" : "Tools";
    var t = i >= 0 && i < list.length ? list[i] : null;
    if (!t) { var eq = equippedIndex(list); if (eq >= 0) t = list[eq]; }
    if (t) {
      hName.textContent = t.label;
      hDesc.textContent = t.tooltip || "";
      var kl = quickLabel(list.indexOf(t));
      hSlot.innerHTML = "";
      if (kl !== null) {
        hSlot.appendChild(document.createTextNode("Key"));
        el(hSlot, "span", {
          display: "inline-block", minWidth: S(30) + "px", padding: S(2) + "px " + S(10) + "px", marginLeft: S(14) + "px",
          border: Math.max(1, S(2)) + "px solid " + LOOK.lineHi, color: LOOK.text, letterSpacing: "0px",
        }, kl);
      }
    } else {
      hName.textContent = list.length ? "" : (state.source === "none" ? "Loading" : "No tools");
      hDesc.textContent = list.length ? "Aim at a tool" : "";
      hSlot.textContent = "";
    }
    hubHotkey();
    hubNode.style.top = (geo.cy - hubNode.offsetHeight / 2) + "px";
  }

  // The hub's last row: "Hotkey [4] Change" normally; while the hotkey is being changed (or its
  // result is shown), the hub holds the prompt instead and the row holds Reset / Cancel.
  function hubButton(parent, label, act) {
    var b = el(parent, "span", {
      display: "inline-block", padding: S(4) + "px " + S(14) + "px", margin: "0px " + S(8) + "px",
      border: Math.max(1, S(2)) + "px solid " + LOOK.lineHi, color: LOOK.text, cursor: "pointer",
    }, label);
    b.__twAct = act;
    return b;
  }
  function hubAction(node) {
    for (var n = node; n && n !== root; n = n.parentNode) if (n.__twAct) return n.__twAct;
    return null;
  }
  function hubHotkey() {
    hHot.innerHTML = "";
    var msg = state.hubMsg && Date.now() < state.hubMsg.until ? state.hubMsg : null;
    if (!msg) state.hubMsg = null;
    if (msg && !state.rebind) { hHdr.textContent = "Hotkey"; hSlot.textContent = ""; hName.textContent = msg.title; hDesc.textContent = msg.text; }
    if (!state.rebind) {
      if (!hot.enabled || hotCode <= 0) return;
      hHot.appendChild(document.createTextNode("Hotkey"));
      el(hHot, "span", {
        display: "inline-block", minWidth: S(30) + "px", padding: S(2) + "px " + S(10) + "px", margin: "0px " + S(6) + "px 0px " + S(14) + "px",
        border: Math.max(1, S(2)) + "px solid " + LOOK.line, color: LOOK.text, letterSpacing: "0px",
      }, hot.label);
      hubButton(hHot, "Change", "rebind");
      return;
    }
    hHdr.textContent = "Hotkey";
    hSlot.textContent = "";
    hName.textContent = state.rebind.waiting ? "Saving" : "Press a key";
    hDesc.textContent = state.rebind.text;
    if (!state.rebind.waiting) { hubButton(hHot, "Reset", "reset"); hubButton(hHot, "Cancel", "cancel"); }
  }

  // Fix 2: selection by angle from the centre, so each tool owns exactly one sector and no two
  // hit areas can overlap. Inside the hub nothing is picked. A flick of the mouse is enough.
  // Past the outer selection bar counts as outside the wheel: a click there closes it. While the
  // hotkey or Alt is held, aiming still works at any distance (hold, flick, release).
  function outsideRing(e) {
    var dx = e.clientX - geo.cx, dy = e.clientY - geo.cy;
    return Math.sqrt(dx * dx + dy * dy) > S(LOOK.RO + 60);
  }
  function sectorAt(e) {
    var dx = e.clientX - geo.cx, dy = e.clientY - geo.cy;
    var n = toolsNow().length;
    if (!n || Math.sqrt(dx * dx + dy * dy) < S(LOOK.HUB)) return -1;
    if (outsideRing(e) && !state.keyDown && !alt.down) return -1;
    var deg = Math.atan2(dy, dx) * 180 / Math.PI + 90; // 0 = up, clockwise
    deg = (deg + 360 + 180 / n) % 360;
    return Math.floor(deg / (360 / n)) % n;
  }
  function mouseLine(e) {
    var dx = e.clientX - geo.cx, dy = e.clientY - geo.cy;
    return e.type + " button=" + e.button + " at " + Math.round(e.clientX) + "," + Math.round(e.clientY) +
      " r=" + Math.round(Math.sqrt(dx * dx + dy * dy)) + " wedge=" + sectorAt(e) + " target=" + describe(e.target);
  }
  root.addEventListener("mousemove", function (e) { if (state.open) setHover(sectorAt(e)); });
  // Every button event that reaches the wheel is logged while it is open, so a click that never
  // arrives (enhanced mouse off, another layer on top) shows up as a missing line.
  root.addEventListener("mouseup", function (e) { if (state.open) log(mouseLine(e)); });
  root.addEventListener("click", function (e) { if (state.open) dbg(mouseLine(e)); });
  document.addEventListener("mousedown", function (e) {
    if (state.open && !state.disposed && !root.contains(e.target)) log("mousedown outside the wheel's layer: target=" + describe(e.target) + " (another HUD layer is on top)");
  }, true);
  root.addEventListener("mousedown", function (e) {
    if (!state.open) return;
    log(mouseLine(e));
    e.stopPropagation();
    var act = e.button === 0 ? hubAction(e.target) : null;
    if (act) { hubClick(act); return; }
    // While the hotkey is being changed, any other click only cancels the change.
    if (state.rebind) { cancelRebind(e.button === 2 ? "right click" : "click"); return; }
    if (e.button === 2) { close("right click"); return; }
    if (e.button !== 0) return;
    if (outsideRing(e)) { close("click outside"); return; }
    pick(sectorAt(e), "click");
  });
  root.addEventListener("contextmenu", function (e) { e.preventDefault(); });

  function pick(i, how) {
    var list = toolsNow();
    if (i < 0 || i >= list.length) { close(how + " in the centre"); return; }
    var tool = list[i];
    close("picked " + tool.name + " by " + how);
    setTimeout(function () { choose(tool); }, 0);
  }

  // ---------------------------------------------------------------- page and cursor
  var page = null;
  if (typeof MousePage === "function") {
    try {
      var WheelPage = class extends MousePage {
        constructor() { super(); this.wrapperNode = root; }
        _onVisibilityChange() {
          super._onVisibilityChange();
          if (!this.isVisible && state.open) {
            state.open = false;
            root.style.display = "none";
            restoreMouse();
            dropRebind("the HUD closed the wheel");
            log("closed by the HUD");
          }
        }
        _close() { close("HUD close"); }
      };
      page = new WheelPage();
    } catch (e) { log("MousePage subclass failed: " + e); page = null; }
  }

  // The first test showed the cursor did not appear with the page alone (the player pressed
  // Tab before clicking). Tab is HudManager.SetEnhancedMouse, which CPPHud.toggleEnhancedMouse
  // drives, so the wheel turns it on while open and back off when it closes.
  function ensureMouse() {
    setTimeout(function () {
      if (!state.open || state.mouseMode === true) return;
      try {
        CPPHud.toggleEnhancedMouse();
        state.toggledMouse = true;
        setTimeout(function () {
          if (state.open) log("[unproven] cursor: toggleEnhancedMouse called, enhanced mouse is now " + state.mouseMode);
        }, 300);
      } catch (e) { log("cursor: CPPHud.toggleEnhancedMouse failed: " + e); }
    }, 120);
  }
  function restoreMouse() {
    if (!state.toggledMouse) return;
    state.toggledMouse = false;
    if (state.mouseMode === true) { try { CPPHud.toggleEnhancedMouse(); } catch (e) { } }
  }

  function open(why) {
    if (state.disposed || state.open) return;
    send(A_DATA, "");
    state.open = true;
    state.hover = -1;
    detectMode("open");
    root.style.display = "block";
    layout();
    render();
    if (page) { try { page.show(true); } catch (e) { log("page.show failed: " + e); } }
    ensureMouse();
    log("opened (" + why + "), " + (groupNow() === "build" ? "build" : "roaming") + " tools: " + toolsNow().length +
      (state.mode ? " (mode from " + state.modeHow + ")" : " (mode not detected yet, DefaultBar " + CFG.defaultBar + ")"));
  }
  function close(why) {
    if (!state.open) return;
    state.open = false;
    state.openedByKey = false;
    root.style.display = "none";
    if (page) { try { page.show(false); } catch (e) { } }
    restoreMouse();
    dropRebind("wheel closed");
    state.hubMsg = null;
    log("closed (" + why + ")");
  }

  // ---------------------------------------------------------------- tool selection
  // A pick succeeds only when the tool is EQUIPPED: the bar answered SelectToolOfToolBar(b) and
  // slot b holds the tool's type. Both steps resolve on the bar's own events; the timeouts are
  // fallbacks only. While a pick is in flight (state.busy) the slot-key restore and the G
  // re-equip stand down, so they cannot act on toolbar events the pick itself causes.
  var LOAD_WAIT_MS = 1500;   // changeItem -> SetContentOfToolBar (in game: 2 ms)
  var SELECT_AFTER_LOAD_MS = 60; // [unproven] settle time between the bar slot's content and its select
  var EQUIP_WAIT_MS = 500;   // selectItem -> SelectToolOfToolBar
  var BUSY_MAX_MS = 8000;    // a pick that never settles frees the wheel after this
  function setBusy(on) { state.busy = on; state.busySince = on ? Date.now() : 0; }
  function isBusy() {
    if (state.busy && Date.now() - state.busySince > BUSY_MAX_MS) { log("previous pick did not settle in " + BUSY_MAX_MS + " ms; freed"); setBusy(false); state.pending = null; }
    return state.busy;
  }
  function fail(tool, what, why) {
    log(what + " FAILED " + tool.name + ": " + why);
    try { CPPHud.addFailureNotification("Tool Wheel: could not " + (what === "LOAD" ? "load " : "equip ") + tool.label + " (" + why + ")"); } catch (e) { }
  }
  // Waits for one toolbar event matching test(); calls back once with true (event) or false (timeout).
  function await_(kind, test, ms, cb) {
    var p = { kind: kind, test: test, cb: null, timer: null };
    function finish(ok) {
      if (p.cb === null) return;
      var f = p.cb; p.cb = null;
      if (p.timer) clearTimeout(p.timer);
      if (state.pending === p) state.pending = null;
      f(ok);
    }
    p.cb = cb;
    p.finish = finish;
    state.pending = p;
    p.timer = setTimeout(function () { if (!state.disposed) finish(false); }, ms);
    return p;
  }
  function pendingEvent(kind, slot) {
    var p = state.pending;
    if (p && p.kind === kind && p.cb && p.test(slot)) p.finish(true);
  }

  // Selects bar slot b and confirms the tool is in hand. One retry when no matching
  // SelectToolOfToolBar arrives (the stock bar toggles, so a slot that is already selected is
  // never selected again).
  function equip(b, tool, quick, how) {
    var id = String(tool.id);
    function inHand() { return state.selectedSlot === b && state.live[b] === id; }
    if (inHand()) {
      setBusy(false);
      log(quick ? "SELECT " + tool.name + " bar " + b + ": already equipped" : "EQUIPPED " + tool.name + " bar " + b + " (already in hand)");
      return;
    }
    setBusy(true);
    function attempt(n) {
      state.keyGuard = null;
      state.ownSelectUntil = Date.now() + EQUIP_WAIT_MS + 100;
      await_("select", function (s) { return s === b && state.live[b] === id; }, EQUIP_WAIT_MS, function (ok) {
        if (ok || inHand()) {
          setBusy(false);
          state.ownSelectUntil = 0; // its own select has arrived: a slot key pressed from now on is the player's
          log("EQUIPPED " + tool.name + " bar " + b + " (" + how + (n ? ", select retried" : "") + ")");
          return;
        }
        if (n === 0) {
          log("SELECT " + tool.name + " bar " + b + ": no SelectToolOfToolBar(" + b + ") in " + EQUIP_WAIT_MS + " ms (selected slot " + state.selectedSlot + "); retrying once");
          attempt(1);
          return;
        }
        setBusy(false);
        fail(tool, "EQUIP", "bar " + b + " did not select it (selected slot " + state.selectedSlot + ", slot holds " + (state.live[b] || "nothing") + ")");
      });
      if (state.selectedSlot === b) { pendingEvent("select", b); return; } // already selected: selecting again would toggle it off
      try { tb("selectItem", b); }
      catch (e) { if (state.pending) state.pending.finish(false); log("SELECT " + tool.name + " bar " + b + ": toolBar.selectItem threw " + e); }
    }
    attempt(0);
  }

  // A script injected after the client sent its toolbar events (every re-injection) has never
  // seen the live bar; without it, slot 1 looks empty and the load would overwrite it (10-09 log:
  // "LOAD PlanetSmoothTool slot 1" with Harvest in slot 1). The server's stored toolbar for the
  // current mode stands in until the next toolbar event.
  function seedLiveBar() {
    if (state.liveKnown) return;
    var ids = (state.serverBars || {})[groupNow()] || [];
    if (!ids.length) { log("live bar not seen since load and no stored toolbar from the server; slots assumed empty"); return; }
    state.live = ids.map(function (v) { var x = String(v); return x === "0" ? "" : x; });
    log("live bar not seen since load; using the server's stored " + groupNow() + " toolbar [" + state.live.join(",") + "]");
  }
  // Where a tool that is not on the bar goes: the first empty slot, else LoadSlot (9th by
  // default), and never the slot the player is holding.
  function loadTarget() {
    var held = state.selectedSlot, i;
    for (i = 0; i < BAR_SLOTS; i++) if (!state.live[i] && i !== held) return i;
    var t = CFG.loadSlot >= 0 && CFG.loadSlot < BAR_SLOTS ? CFG.loadSlot : BAR_SLOTS - 1;
    if (t !== held) return t;
    for (i = BAR_SLOTS - 1; i >= 0; i--) if (i !== held) return i;
    return t;
  }
  function choose(tool, quick) {
    if (isBusy()) { log("busy with the previous pick; ignored " + tool.name); return; }
    seedLiveBar();
    if (SINGLE) { chooseSingle(tool, quick, true, "pick"); return; }
    var s = liveSlotOf(String(tool.id));
    if (s >= 0) { equip(s, tool, quick, "on the bar"); return; }
    var target = loadTarget();
    setBusy(true);
    loadInto(target, tool, function (ok, why) {
      if (ok) setTimeout(function () { if (!state.disposed) equip(target, tool, quick, "loaded"); }, SELECT_AFTER_LOAD_MS);
      else { setBusy(false); fail(tool, "LOAD", "bar " + target + ": " + why); }
    });
  }

  // ---------------------------------------------------------------- single-slot bar
  // SingleSlotBar: each tool bar (roaming and build) holds ONE tool, in slot D (LoadSlot, the
  // 9th by default); every other slot stays empty. The stock slot keys 1-9 are native bindings the
  // HUD cannot block, so an empty slot is what makes a stray key harmless: Dual.exe's
  // ToolBarContainer select (0x140c997c0) with an empty slot unequips the tool in hand and selects
  // nothing, and the slot-key guard below then puts the tool back in hand.
  // Clearing is toolBar.resetItem(barIndex): ToolBarPanel::resetItem (0x141460260) ->
  // ToolBarContainer reset slot (0x140c99310), which unequips the slot if it is selected, writes an
  // empty item and notifies (ClearContentOfToolBar, and the bar saves itself to the server, as it
  // does after changeItem). On an empty slot it does nothing.
  var SINGLE = !!CFG.singleSlot;
  var D = CFG.loadSlot >= 0 && CFG.loadSlot < BAR_SLOTS ? CFG.loadSlot : BAR_SLOTS - 1;
  // Clears every slot except keepSlot (-1 = all). Returns the slots it reset.
  function clearSlots(keepSlot, why) {
    var cleared = [], n = Math.max(BAR_SLOTS, state.live.length);
    state.ownSelectUntil = Date.now() + 250; // the unequip this may cause is the wheel's own
    for (var i = 0; i < n; i++) {
      if (i === keepSlot || (state.liveKnown && !state.live[i])) continue;
      try {
        tb("resetItem", i);
        state.live[i] = "";
        if (state.selectedSlot === i) state.selectedSlot = -1;
        cleared.push(i + 1);
      } catch (e) { log("CLEAR bar " + i + ": toolBar.resetItem threw " + e); }
    }
    if (cleared.length) log("CLEAR slot(s) " + cleared.join(",") + " (" + why + "); the bar keeps only slot " + (D + 1));
    return cleared;
  }
  // Puts the tool in slot D, alone. equipIt: also take it in hand (a pick); false = only arrange
  // the bar (normalising a bar the player is not holding anything from).
  function chooseSingle(tool, quick, equipIt, why) {
    var id = String(tool.id);
    if (state.live[D] === id) {
      clearSlots(D, why);
      if (equipIt) equip(D, tool, quick, "in slot " + (D + 1));
      return;
    }
    // Everything goes, D included: a tool held in D is unequipped by its reset, so the select
    // after the load equips the new tool instead of toggling the old one off.
    clearSlots(-1, why);
    setBusy(true);
    loadInto(D, tool, function (ok, why2) {
      if (!ok) { setBusy(false); fail(tool, "LOAD", "bar " + D + ": " + why2); return; }
      if (equipIt) setTimeout(function () { if (!state.disposed) equip(D, tool, quick, "loaded"); }, SELECT_AFTER_LOAD_MS);
      else { setBusy(false); log("BAR " + tool.name + " placed in slot " + (D + 1) + " (" + why + ")"); }
    });
  }
  // A bar seen with tools outside slot D (login, a mode switch to a bar not yet arranged, a stock
  // drag) is brought back to one slot: the tool in hand, else the one in D, else the first one,
  // goes to D; the rest are cleared. Runs once the bar's burst of events has settled.
  var norm = { timer: null, tries: 0 };
  function normalizeSoon(trigger) {
    if (!SINGLE) return;
    if (norm.timer) clearTimeout(norm.timer);
    norm.timer = setTimeout(function () { norm.timer = null; if (!state.disposed) normalizeBar(trigger); }, 400);
  }
  function strayTools() {
    var out = [];
    for (var i = 0; i < state.live.length; i++) if (i !== D && state.live[i]) out.push(i);
    return out;
  }
  function normalizeBar(trigger) {
    if (!SINGLE || !state.liveKnown) return;
    var stray = strayTools();
    if (!stray.length) { norm.tries = 0; return; }
    if (state.open || isBusy()) { normalizeSoon(trigger); return; }
    if (++norm.tries > 3) { if (norm.tries === 4) log("BAR still holds slot(s) " + stray.map(function (i) { return i + 1; }).join(",") + " after 3 tries; left as is until the next pick"); return; }
    var held = state.selectedSlot >= 0 ? state.live[state.selectedSlot] || "" : "";
    var keepId = held || state.live[D] || state.live[stray[0]];
    var tool = findTool(keepId);
    if (!tool) {
      if (!(state.tools.explore || []).length && !(state.tools.build || []).length) { norm.tries--; return; } // no tool data yet: the data event retries
      log("BAR keeps type " + keepId + ", which is not in the wheel's tool list; clearing the other slots only");
      clearSlots(liveSlotOf(keepId), "normalise at " + trigger);
      return;
    }
    log("BAR normalise at " + trigger + ": tools in slot(s) " + stray.map(function (i) { return i + 1; }).join(",") +
      "; keeping " + tool.name + (held ? " (in hand)" : "") + " in slot " + (D + 1));
    chooseSingle(tool, false, !!held, "normalise at " + trigger);
  }

  // toolBar.changeItem(barIndex, storageIdStr, storageSlot) is the stock drag-from-inventory
  // handler (Dual.exe ToolBarPanel::changeItem): bar index 0-based, the id of the storage the
  // item comes from as a string ("0" = nanopack), and the item's slot in that storage. The bar
  // answers with SetContentOfToolBar(barIndex, the tool) and saves itself to the server.
  // The slot comes from the server with each tool (tool.slot). It can move, so a load with an
  // unknown slot, or one the bar does not answer, re-asks the server once and tries again.
  var NANOPACK = "0";
  function slotOf(tool) { return typeof tool.slot === "number" && tool.slot >= 0 ? tool.slot : -1; }
  function findTool(id) {
    var groups = ["explore", "build"];
    for (var g = 0; g < groups.length; g++) {
      var list = state.tools[groups[g]] || [];
      for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    }
    return null;
  }
  // Asks the server for fresh tool data (unthrottled) and calls then() when it arrives, or after
  // 2 s with whatever the wheel has.
  function refreshTools(then) {
    var done = false;
    function fire() { if (done) return; done = true; then(); }
    state.dataWaiters.push(fire);
    if (!send(A_DATA, "refresh")) { fire(); return; }
    setTimeout(fire, 2000);
  }
  // Resolves on the SetContentOfToolBar(bar, tool) event itself.
  function loadInto(bar, tool, done, retried) {
    function again(reason) {
      if (retried) { done(false, reason); return; }
      log("LOAD " + tool.name + " bar " + bar + ": " + reason + "; asking the server for its slot again");
      refreshTools(function () {
        var fresh = findTool(tool.id);
        if (!fresh) { done(false, "no longer in the nanopack"); return; }
        loadInto(bar, fresh, done, true);
      });
    }
    var slot = slotOf(tool), id = String(tool.id), t0 = Date.now();
    if (slot < 0) { again("nanopack slot unknown"); return; }
    await_("content", function (s) { return s === bar && state.live[bar] === id; }, LOAD_WAIT_MS, function (ok) {
      log("LOAD " + tool.name + " bar " + bar + " from nanopack slot " + slot + ": " +
        (ok ? "ok (SetContentOfToolBar after " + (Date.now() - t0) + " ms)" : "no SetContentOfToolBar(" + bar + ", " + id + ") in " + LOAD_WAIT_MS + " ms"));
      if (ok) done(true);
      else again("nanopack slot " + slot + " looks stale (no SetContentOfToolBar)");
    });
    try { tb("changeItem", bar, NANOPACK, slot); }
    catch (e) {
      if (state.pending) state.pending.cb = null;
      state.pending = null;
      log("LOAD " + tool.name + " bar " + bar + " from nanopack slot " + slot + ": failed (changeItem threw " + e + ")");
      again("changeItem threw");
    }
  }

  // ---------------------------------------------------------------- hotkey
  // The HUD's key events carry keyCode only (key and code are undefined). Digit keys do reach it
  // (the 10-09 log has keydown 52 for "4"), so the default is 4. Tap to toggle; hold, aim,
  // release to pick. Opt-in HoldAlt: hold Alt for 150 ms with no other key to open, release to pick.
  function isTyping() {
    var a = document.activeElement;
    if (!a) return false;
    var t = (a.tagName || "").toUpperCase();
    return t === "INPUT" || t === "TEXTAREA" || a.isContentEditable === true;
  }
  // The live hotkey: the config one until the server sends this player's own (ToolWheel.hotkey,
  // at load and after every change), so a change applies at once, with no re-injection.
  var hotCode = CFG.hotkeyCode | 0;
  var hot = { label: keyLabel(hotCode), custom: false, configCode: hotCode, configLabel: keyLabel(hotCode), enabled: !!CFG.enableHotkey };
  var seenHotkey = false;
  function isHot(e) {
    var c = e.keyCode || e.which;
    return hotCode > 0 && (c === hotCode || (hotCode >= 48 && hotCode <= 57 && c === hotCode + 48));
  }
  function onKey(e) {
    if (!live()) return;
    var c = e.keyCode || e.which;
    var repeat = state.keyDown && isHot(e);
    if (e.type === "keydown" && !repeat) {
      // Every key that reaches the HUD while the wheel is open is logged (always), to confirm
      // which codes arrive (- and = in particular); outside the wheel only with debug on.
      var kl = "keydown keyCode=" + c + " wheelOpen=" + state.open + " typing=" + isTyping() + " mouseMode=" + state.mouseMode;
      if (state.open) log(kl); else dbg(kl);
    }
    // Changing the hotkey: the next key is the answer, and nothing else sees it.
    if (state.rebind && state.open) { if (e.type === "keydown" && !repeat) rebindKey(c); return; }
    if (e.type === "keydown" && c === 27 && state.open) { close("escape"); return; }
    if (c === G_CODE && !state.open && !isTyping()) holsterKey(e);
    // Quick-select: while open, a wedge's key equips that tool and closes the wheel. This includes
    // the hotkey itself when it is also a wedge key (4 by default): then 4 picks wedge 4 and does
    // not close the wheel; Esc, right-click or a click outside close it.
    if (e.type === "keydown" && state.open && !repeat && !isTyping()) {
      var n = toolsNow().length, qi = quickIndex(c, n);
      if (qi >= 0) {
        if (isHot(e)) { state.keyDown = true; state.keyDownAt = Date.now(); }
        quickSelect(qi, c);
        return;
      }
      if (!isHot(e) && quickIndex(c, QUICK.length) >= 0) { log("quick key keyCode " + c + ": no wedge for it (" + n + " tools in this mode)"); return; }
    }
    if (CFG.holdAlt && !isTyping()) holdAlt(e, c);
    // Stock slot keys 1-9 with the wheel closed: in single-slot mode the slots other than D are
    // empty, so the stock binding only unequips; the guard puts the tool back. D's own key is left
    // to the game (select, or put away when held: the same as G).
    if (SINGLE && e.type === "keydown" && !state.open && !isTyping() && c >= 49 && c <= 57 && c - 49 !== D && !(CFG.enableHotkey && isHot(e))) {
      if (!state.keyGuard || state.keyGuard.code !== c || Date.now() > state.keyGuard.until) armKeyGuard(c, "slot key");
    }
    if (e.type === "keydown" && c === 73 && !isTyping()) {
      inventoryKeyCheck(); // I: the stock inventory key
      if (trace.on) setTimeout(function () { try { traceInventoryTiles(); } catch (e2) { tlog("inventory tiles failed: " + e2); } }, 900);
    }
    if (!CFG.enableHotkey || !isHot(e) || isTyping()) return;
    if (!seenHotkey) { seenHotkey = true; log("hotkey keyCode " + c + " reaches the HUD"); }
    if (e.type === "keydown") {
      if (state.keyDown) return; // auto-repeat while held
      state.keyDown = true;
      state.keyDownAt = Date.now();
      armKeyGuard(c, "hotkey");
      if (state.open) close("hotkey");
      else { open("hotkey"); state.openedByKey = true; }
    } else if (e.type === "keyup") {
      if (state.open) log("keyup keyCode=" + c + " held " + (Date.now() - state.keyDownAt) + " ms, aimed wedge " + state.hover);
      state.keyDown = false;
      if (state.open && state.openedByKey && Date.now() - state.keyDownAt > 300) {
        if (state.hover >= 0) pick(state.hover, "hotkey release");
        else close("hotkey released with nothing aimed");
      }
    }
  }
  // ---------------------------------------------------------------- changing the hotkey (in the wheel)
  // DU's Controls menu cannot be extended from a mod, so the hotkey is changed here: hub > Change
  // (or Tool Wheel > Set hotkey), then the next key that reaches the HUD is the new hotkey. A key
  // that does not reach the HUD never arrives, so it cannot be chosen. The server stores it per
  // player (Mods/ToolWheel/player-hotkeys.json) and answers with ToolWheel.hotkey.
  // Same tables as PlayerHotkeys.Label / Refusal on the server (tested there); the server decides.
  function keyLabel(c) {
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90)) return String.fromCharCode(c);
    if (c >= 96 && c <= 105) return "Num " + (c - 96);
    if (c >= 112 && c <= 123) return "F" + (c - 111);
    var names = {
      106: "Num *", 107: "Num +", 109: "Num -", 110: "Num .", 111: "Num /", 186: ";", 187: "=", 61: "=", 188: ",", 189: "-", 173: "-",
      190: ".", 191: "/", 192: "`", 219: "[", 220: "\\", 221: "]", 222: "'", 33: "PgUp", 34: "PgDn", 35: "End", 36: "Home",
      45: "Ins", 46: "Del", 37: "Left", 38: "Up", 39: "Right", 40: "Down",
    };
    return names[c] || "key " + c;
  }
  function hotkeyRefusal(c) {
    if (c <= 0 || c > 255) return "not a key";
    var no = {
      27: "Esc cancels", 8: "Backspace resets the hotkey in the prompt", 9: "Tab toggles the cursor", 13: "Enter opens the chat",
      16: "modifier keys cannot be the hotkey", 17: "modifier keys cannot be the hotkey", 18: "modifier keys cannot be the hotkey",
      20: "lock keys cannot be the hotkey", 144: "lock keys cannot be the hotkey", 145: "lock keys cannot be the hotkey",
      91: "the Windows and menu keys do not stay in the game", 92: "the Windows and menu keys do not stay in the game",
      93: "the Windows and menu keys do not stay in the game", 44: "Print Screen takes screenshots",
      71: "G is the holster key, which the wheel already handles",
      87: "a movement key would open the wheel while moving", 65: "a movement key would open the wheel while moving",
      83: "a movement key would open the wheel while moving", 68: "a movement key would open the wheel while moving",
      32: "a movement key would open the wheel while moving",
    };
    return no[c] || null;
  }
  // What else the key does, for the result line: a quick key still picks its wedge while open.
  function hotkeyNote(c) {
    var qi = quickIndex(c, QUICK.length);
    return qi >= 0 ? " With the wheel open, " + keyLabel(c) + " picks wedge " + (qi + 1) + "; Esc closes it." : "";
  }
  function applyHotkey(d) {
    var before = hotCode;
    hotCode = d.code | 0;
    hot = { label: d.label || keyLabel(hotCode), custom: !!d.custom, configCode: d.configCode | 0, configLabel: d.configLabel || keyLabel(d.configCode | 0), enabled: d.enabled !== false };
    if (before !== hotCode) { seenHotkey = false; state.keyDown = false; }
    return before !== hotCode;
  }
  function refreshHub() { if (state.open) setHover(state.hover, true); }
  function startRebind(why) {
    if (!hot.enabled) { log("hotkey change unavailable: the hotkey is turned off on this server"); return; }
    if (state.rebind && state.rebind.timer) clearTimeout(state.rebind.timer);
    state.openedByKey = false; // the hotkey's own release must not pick a wedge
    state.hubMsg = null;
    state.rebind = { why: why, waiting: false, timer: null, text: "Esc cancels. Backspace resets it to " + hot.configLabel + "." };
    log("hotkey change: waiting for a key (" + why + "); now " + hot.label + " (keyCode " + hotCode + (hot.custom ? ", this player's own" : ", the server default") + ")");
    refreshHub();
  }
  function dropRebind(why) {
    var r = state.rebind;
    if (!r) return;
    if (r.timer) clearTimeout(r.timer);
    state.rebind = null;
    log("hotkey change cancelled (" + why + "); still " + hot.label);
  }
  function cancelRebind(why) { dropRebind(why); refreshHub(); }
  function endRebind(title, text) {
    var r = state.rebind;
    if (r && r.timer) clearTimeout(r.timer);
    state.rebind = null;
    state.hubMsg = { title: title, text: text, until: Date.now() + 4000 };
    refreshHub();
    setTimeout(function () { if (!state.disposed && !state.rebind) refreshHub(); }, 4100);
  }
  function rebindKey(c) {
    var r = state.rebind;
    if (r.waiting) return;
    if (c === 27) { cancelRebind("Esc"); return; }
    // A digit is also a stock tool bar slot key: undo that switch, as for the hotkey itself.
    if (c >= 48 && c <= 57) armKeyGuard(c, "hotkey change key");
    if (c === 8) { requestHotkey("reset", "a reset to " + hot.configLabel); return; }
    var why = hotkeyRefusal(c);
    if (why) {
      log("hotkey change: " + keyLabel(c) + " (keyCode " + c + ") refused: " + why);
      r.text = keyLabel(c) + " cannot be the hotkey: " + why + ". Press another key.";
      refreshHub();
      return;
    }
    if (c === hotCode) { log("hotkey change: " + keyLabel(c) + " is already the hotkey"); endRebind("Unchanged", keyLabel(c) + " is already the hotkey."); return; }
    requestHotkey("set:" + c, keyLabel(c) + " (keyCode " + c + ")");
  }
  function requestHotkey(payload, what) {
    var r = state.rebind;
    r.waiting = true;
    r.text = "Saving " + what + ".";
    if (!send(A_HOTKEY, payload)) { endRebind("Not saved", "The server could not be reached; the hotkey is still " + hot.label + "."); return; }
    log("hotkey change: asked the server for " + what);
    r.timer = setTimeout(function () {
      if (state.rebind !== r) return;
      log("hotkey change: no answer from the server in 4 s; still " + hot.label);
      endRebind("Not saved", "No answer from the server; the hotkey is still " + hot.label + ".");
    }, 4000);
    refreshHub();
  }
  function hubClick(act) {
    if (act === "rebind") startRebind("hub button");
    else if (act === "cancel") cancelRebind("Cancel button");
    else if (act === "reset" && state.rebind) requestHotkey("reset", "a reset to " + hot.configLabel);
  }

  // ---------------------------------------------------------------- quick-select and the stock slot keys
  // The quick keys are also the game's own "tool bar slot N" keys (the stock bar is hidden but
  // still there), so pressing 7 also makes the stock bar switch to slot 7, after the HUD has the
  // keydown. The wheel's choice must win: a stock selection change within 700 ms of the key that
  // is not the wheel's tool is undone by selecting the wheel's tool again, once the wheel's own
  // select (or load) has settled. Same idea as the hotkey restore below.
  function quickSelect(i, code) {
    var tool = toolsNow()[i], now = Date.now(), key = quickLabel(i);
    state.keyGuard = null;
    if (state.quickGuard && state.quickGuard.timer) clearTimeout(state.quickGuard.timer);
    state.quickGuard = { key: key, code: code, tool: tool, at: now, until: now + 700, stock: null, timer: null };
    close("quick-select key " + key + " (keyCode " + code + ") -> " + tool.name);
    setTimeout(function () { choose(tool, true); }, 0);
    setTimeout(function () {
      var g = state.quickGuard;
      if (g && g.at === now && g.stock === null) {
        state.quickGuard = null;
        log("quick-select key " + key + " -> " + tool.name + "; no stock slot switch seen");
      }
    }, 750);
  }
  // Called from SelectToolOfToolBar(slot) and DeselectCurrentToolOfToolBar (slot -1).
  function quickGuardCheck(slot) {
    var g = state.quickGuard;
    if (!g || Date.now() > g.until) return;
    var want = liveSlotOf(g.tool.id);
    if (want >= 0 && slot === want) return; // the wheel's own select, or the stock key hit the same tool
    g.stock = slot;
    quickSettle(g, 0);
  }
  function quickSettle(g, tries) {
    if (g.timer) clearTimeout(g.timer);
    g.timer = setTimeout(function () {
      g.timer = null;
      if (state.quickGuard !== g || state.disposed) return;
      var want = liveSlotOf(g.tool.id);
      // Still loading the tool, or the wheel's own select has not answered yet: wait (up to ~2 s).
      if ((state.busy || (Date.now() < state.ownSelectUntil && state.selectedSlot !== want)) && tries < 12) { quickSettle(g, tries + 1); return; }
      state.quickGuard = null;
      var stock = g.stock >= 0 ? "slot " + (g.stock + 1) : "nothing";
      if (want < 0) { log("quick-select key " + g.key + " -> " + g.tool.name + ": stock switch to " + stock + " seen, but the tool is not on the bar; left as is"); return; }
      if (state.selectedSlot !== want) {
        state.ownSelectUntil = Date.now() + 500;
        try { tb("selectItem", want); }
        catch (e) { log("quick-select key " + g.key + " -> " + g.tool.name + ": re-selecting slot " + (want + 1) + " threw " + e); return; }
      }
      log("quick-select key " + g.key + " -> " + g.tool.name + "; stock switch overridden (stock went to " + stock + ", wheel tool in slot " + (want + 1) + ")");
    }, 150);
  }

  // ---------------------------------------------------------------- slot-key guard
  // A digit hotkey is also the game's own "tool bar slot N" binding, which the HUD cannot block:
  // the client handles it natively and the HUD only gets a copy. The log shows the order:
  // keydown 52 first, then SelectToolOfToolBar(3) (or DeselectCurrentToolOfToolBar when slot 4
  // was already equipped, the stock toggle). So the selection at keydown is remembered and the
  // first stock selection change within the next 700 ms is undone. Unbinding the slot key in
  // DU's Controls settings makes this unnecessary; it is harmless then (no event, no restore).
  function armKeyGuard(code, kind) {
    if (code < 48 || code > 57) return; // only digits collide with stock slot keys
    var now = Date.now();
    state.keyGuard = { prior: state.selectedSlot, at: now, until: now + 700, code: code, kind: kind || "hotkey" };
    setTimeout(function () {
      var g = state.keyGuard;
      if (g && g.at === now) {
        state.keyGuard = null;
        dbg(g.kind + " " + code + ": no stock slot change to undo (slot " + (g.prior + 1) + " kept)");
      }
    }, 750);
  }
  function deselectTool(slot) {
    var names = ["deselectItem", "deselectCurrentItem", "unselectItem", "deselect"];
    for (var i = 0; i < names.length; i++) {
      if (typeof toolBar[names[i]] === "function") { tb(names[i]); return "toolBar." + names[i] + "()"; }
    }
    // The stock bar toggles: selecting the equipped slot again unequips it.
    tb("selectItem", slot);
    return "toolBar.selectItem(" + slot + ") again (toggle)";
  }
  // Called from SelectToolOfToolBar(slot) and DeselectCurrentToolOfToolBar (slot -1).
  function keyGuardCheck(slot) {
    var g = state.keyGuard, now = Date.now();
    if (!g || now > g.until || now < state.ownSelectUntil) return;
    state.keyGuard = null;
    if (isBusy()) { log(g.kind + " " + g.code + ": stock switch to " + (slot >= 0 ? "slot " + (slot + 1) : "nothing") + " left alone, a wheel pick is in flight (it selects its own slot)"); return; }
    if (slot === g.prior) return;
    var prior = g.prior, wheelOpen = state.open;
    state.ownSelectUntil = now + 500;
    setTimeout(function () {
      var how;
      try {
        if (prior >= 0) { tb("selectItem", prior); how = "toolBar.selectItem(" + prior + ")"; }
        else how = deselectTool(slot);
      } catch (e) { log(g.kind + " " + g.code + ": undoing the stock slot " + (slot + 1) + " switch failed: " + e); return; }
      log(g.kind + " " + g.code + (g.kind === "hotkey" ? " " + (wheelOpen ? "opened" : "closed") + " wheel" : "") + "; restored slot " +
        (prior >= 0 ? String(prior + 1) : "none (nothing was equipped)") + " after the stock binding switched to " +
        (slot >= 0 ? "slot " + (slot + 1) : "nothing") + ", via " + how);
    }, 0);
  }

  var alt = { down: false, other: false, opened: false, timer: null };
  function holdAlt(e, c) {
    if (e.type === "keydown" && c === 18) {
      if (alt.down) return; // auto-repeat
      alt.down = true; alt.other = false;
      alt.timer = setTimeout(function () {
        alt.timer = null;
        if (alt.down && !alt.other && !state.open) { open("hold Alt"); alt.opened = state.open; }
      }, 150);
    } else if (e.type === "keydown") {
      alt.other = true; // Alt is part of a stock combo
      if (alt.timer) { clearTimeout(alt.timer); alt.timer = null; }
    } else if (e.type === "keyup" && c === 18) {
      alt.down = false;
      if (alt.timer) { clearTimeout(alt.timer); alt.timer = null; }
      if (alt.opened) {
        alt.opened = false;
        if (state.open) {
          if (state.hover >= 0) pick(state.hover, "Alt release");
          else close("Alt released with nothing aimed");
        }
      }
    }
  }
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("keyup", onKey, true);

  // ---------------------------------------------------------------- HUD icon (click to open)
  if (CFG.showHudIcon) {
    try {
      var icon = new NotificationIconComponent("icon_missing", "toolwheel");
      icon.onClickEvent.subscribe(function () { if (!state.disposed) { if (state.open) close("hud icon"); else open("hud icon"); } });
      hudManager.addNotificationIcon(icon);
      try { icon.HTMLNodes.icon.innerText = "TW"; } catch (e) { }
      state.icon = icon;
    } catch (e) { log("HUD icon unavailable (" + e + "); use the right-click menu: Tool Wheel > Open"); }
  }

  // ---------------------------------------------------------------- events
  on("ToolWheel.show", function (arg) { open(arg ? "server: " + arg : "server"); });
  on("ToolWheel.hide", function () { close("server"); });
  // Tool Wheel > Set hotkey: open the wheel on the prompt.
  on("ToolWheel.rebind", function (arg) {
    if (!state.open) open("server: set hotkey");
    if (state.open) startRebind(arg ? "server: " + arg : "server");
  });
  // This player's hotkey: at load ("info") and as the answer to a change ("set", "reset", "refused").
  on("ToolWheel.hotkey", function (json) {
    var d = JSON.parse(json), changed = applyHotkey(d), r = state.rebind;
    if (d.result === "refused") {
      log("hotkey change: the server refused " + (d.askedLabel || "the key") + ": " + d.reason + "; still " + hot.label);
      if (r && state.open) {
        if (r.timer) clearTimeout(r.timer);
        r.timer = null; r.waiting = false;
        r.text = (d.askedLabel || "That key") + " cannot be the hotkey: " + d.reason + ". Press another key.";
        refreshHub();
      }
      return;
    }
    if (d.result === "set" || d.result === "reset") {
      log("hotkey now " + hot.label + " (keyCode " + hotCode + ", " + (d.result === "reset" ? "reset to the server default" : "saved for this player") + ")");
      if (!state.open) open("hotkey " + d.result); // Tool Wheel > Reset hotkey: show the result
      endRebind(d.result === "reset" ? "Hotkey reset" : "Hotkey set", "The wheel now opens with " + hot.label + "." + hotkeyNote(hotCode));
      return;
    }
    if (changed) log("hotkey " + hot.label + " (keyCode " + hotCode + (hot.custom ? ", this player's own" : ", the server default") + ")");
    refreshHub();
  });
  on("ToolWheel.debug", function (arg) {
    debug = arg === "toggle" ? !debug : arg === "on";
    try { console.log(TAG + "debug " + (debug ? "on" : "off")); } catch (e) { }
    forward("debug " + (debug ? "on" : "off"));
    if (debug) { try { probe(); } catch (e) { dbg("probe failed: " + e); } }
    try { if (debug) installTrace(); else uninstallTrace(); } catch (e) { log("trace " + (debug ? "install" : "removal") + " failed: " + e); }
  });
  on("ToolWheel.data", function (json) {
    var d = JSON.parse(json);
    state.source = d.source || "?";
    state.tools = d.tools || { explore: [], build: [] };
    state.serverBars = d.bars || { explore: [], build: [] };
    detectMode("tool data");
    inventorySoon("tool data");
    dbg("data from " + d.source + ": explore " + short((state.tools.explore || []).map(function (t) { return t.name; }).join(" "), 500) +
      " | build " + short((state.tools.build || []).map(function (t) { return t.name; }).join(" "), 500));
    if (state.open) { layout(); render(); }
    normalizeSoon("tool data");
    var w = state.dataWaiters; state.dataWaiters = [];
    w.forEach(function (f) { try { f(); } catch (e) { log("data waiter threw: " + e); } });
  });

  // ---------------------------------------------------------------- mode (roaming or build)
  // The wheel follows the game's mode: build tools only in build mode, roaming tools outside it,
  // as the stock bar does. [unproven] No HUD flag for build mode is known, so the mode is read
  // from which group of tools the stock bar holds, since the game swaps the roaming and build
  // bars with the mode. Sources, best first: the tool icons drawn in #action_bar (what the
  // player sees now), then the toolbar engine events since the last InitializeToolBar.
  // Mode-like HUD events are logged (debug) to find a direct signal later.
  function stockBarIcons() {
    var out = [], ab = document.getElementById("action_bar");
    if (!ab) return out;
    var all = ab.getElementsByTagName("*");
    for (var i = 0; i < all.length; i++) {
      var src = all[i].tagName === "IMG" ? (all[i].getAttribute("src") || "") : ((cs(all[i]) || {}).backgroundImage || "");
      var m = src.match(/iconsLib\/misclib\/([^"')?]+)/i);
      if (m) out.push(m[1].toLowerCase());
    }
    return out;
  }
  function countBy(match) {
    var hits = { explore: 0, build: 0 };
    ["explore", "build"].forEach(function (g) {
      (state.tools[g] || []).forEach(function (t) { if (match(t)) hits[g]++; });
    });
    return hits;
  }
  function detectMode(trigger) {
    var hits = null, how = null;
    var icons = stockBarIcons();
    if (icons.length) {
      var h1 = countBy(function (t) { return icons.indexOf(String(t.icon).toLowerCase()) >= 0; });
      if (h1.explore !== h1.build) { hits = h1; how = "stock bar icons"; }
    }
    if (!hits && state.liveKnown) {
      var h2 = countBy(function (t) { return state.live.indexOf(String(t.id)) >= 0; });
      if (h2.explore !== h2.build) { hits = h2; how = "toolbar events"; }
    }
    if (!hits) {
      dbg("mode: undecided at " + trigger + " (" + icons.length + " stock bar icon(s), live bar " +
        (state.liveKnown ? "[" + state.live.join(",") + "]" : "not seen") + "); keeping " + (state.mode || "DefaultBar " + CFG.defaultBar));
      return;
    }
    var m = hits.explore > hits.build ? "explore" : "build", changed = m !== state.mode;
    if (changed || how !== state.modeHow) {
      log("[unproven] mode: " + (m === "build" ? "build" : "roaming") + ", from " + how + " (" + hits.explore +
        " roaming / " + hits.build + " build tools on the stock bar; at " + trigger + ")");
    }
    state.mode = m;
    state.modeHow = how;
    if (changed && state.open) { state.hover = -1; layout(); render(); }
  }
  var modeTimer = null;
  function detectSoon(trigger) {
    if (modeTimer) clearTimeout(modeTimer);
    if (norm.timer) clearTimeout(norm.timer);
    modeTimer = setTimeout(function () { modeTimer = null; if (!state.disposed) detectMode(trigger); }, 150);
  }

  // The toolbar item, whatever form it arrives in: a JSON string (seen in game), an object, or a
  // bare type id. "" = nothing readable.
  function itemTypeId(item) {
    var o = item;
    if (typeof o === "string") {
      var t = o.trim();
      if (/^\d+$/.test(t)) return t;
      try { o = JSON.parse(t); } catch (e) { return ""; }
    }
    if (typeof o === "number") return String(o);
    if (!o || typeof o !== "object" || o.typeId === undefined || o.typeId === null) return "";
    var id = String(o.typeId);
    return id === "0" ? "" : id;
  }
  // Live stock bar, from the events the client sends it. This is what selectItem indexes.
  on("InitializeToolBar", function (n) {
    dbg("event InitializeToolBar" + argsOf(arguments));
    state.live = [];
    for (var i = 0; i < (n | 0); i++) state.live.push("");
    state.liveKnown = (n | 0) > 0;
    detectSoon("InitializeToolBar");
    stockBarSoon("InitializeToolBar");
    norm.tries = 0;
    normalizeSoon("InitializeToolBar");
  });
  // The 18:23 log has SetContentOfToolBar(2, <the requested tool>) right after every load, yet
  // each load was reported failed: the slot is compared as a number from here on, and its
  // arrival type is logged.
  // ROOT CAUSE of the 10-09 18:50 "could not load": the item arrives as a JSON STRING, so
  // item.typeId was undefined and every slot was recorded as empty: no tool was ever found on
  // the bar, every load went to bar 0, and no load ever matched its event. itemTypeId parses it.
  on("SetContentOfToolBar", function (slot, item) {
    dbg("event SetContentOfToolBar" + short(argsOf(arguments), 400) + " (slot arrives as " + typeof slot + ", item as " + typeof item + ")");
    slot = Number(slot);
    var id = itemTypeId(item);
    while (state.live.length <= slot) state.live.push("");
    state.live[slot] = id;
    state.liveKnown = true;
    state.contentEvents.push({ at: Date.now(), slot: slot, id: id });
    if (state.contentEvents.length > 30) state.contentEvents.shift();
    detectSoon("SetContentOfToolBar");
    stockBarSoon("SetContentOfToolBar");
    pendingEvent("content", slot);
    if (slot !== D) normalizeSoon("SetContentOfToolBar");
  });
  on("ClearContentOfToolBar", function (slot) {
    dbg("event ClearContentOfToolBar" + argsOf(arguments));
    slot = Number(slot);
    if (slot >= 0 && slot < state.live.length) state.live[slot] = "";
  });
  on("SelectToolOfToolBar", function (slot) {
    slot = Number(slot);
    state.selectedSlot = slot;
    state.lastSelectEventAt = Date.now();
    dbg("event SelectToolOfToolBar" + argsOf(arguments));
    keyGuardCheck(slot);
    quickGuardCheck(slot);
    pendingEvent("select", slot);
    stockBarSoon("SelectToolOfToolBar");
  });
  on("DeselectCurrentToolOfToolBar", function () {
    // Whatever put the tool away (G, the slot key of the tool's own slot, a stray key), the next
    // G takes it back out.
    if (state.selectedSlot >= 0 && state.live[state.selectedSlot]) holster.id = state.live[state.selectedSlot];
    state.selectedSlot = -1;
    dbg("event DeselectCurrentToolOfToolBar");
    keyGuardCheck(-1);
    quickGuardCheck(-1);
  });
  on("HudManager.SetEnhancedMouse", function (v) {
    state.mouseMode = v;
    dbg("event HudManager.SetEnhancedMouse" + argsOf(arguments));
  });
  ["ShowToolBarWidget", "HudManager.setContext", "HudManager.SetBuildEnhancedMode"].forEach(function (name) {
    on(name, function () { dbg("event " + name + short(argsOf(arguments), 300)); detectSoon(name); stockBarSoon(name); });
  });

  // ---------------------------------------------------------------- stock tool bar: hide
  // The wheel replaces the stock tool bar, so it is hidden (HideStockBar). Only the TOOL bar:
  // the consumable bar and the rest of the HUD stay. The bar keeps existing and keeps getting
  // its events, so toolBar.selectItem / changeItem and mode detection (which reads the icons'
  // src / computed background, not layout) still work.
  // Finding it: no class name is assumed. The leading compound selector of every rule in the
  // HUD's own tool_bar.css (coui://data/gui/hud/action_bar/css/tool_bar.css) is looked up
  // inside #action_bar; the outermost matches that hold nothing styled by consumable_bar.css
  // are the tool bar. Method 1 is window.toolbar.visible = false (the stock view object has a
  // boolean "visible"); it is kept only if those elements then measure as not shown and the
  // consumable bar does not change. Otherwise method 2, display:none on those elements.
  var bar = { how: null, trying: false, els: [], sels: "", observer: null, poll: null, timer: null, lastLog: "" };
  var tokenCache = {};
  // First compound of a selector that names a class or id and is not #action_bar or one of its
  // ancestors ("#action_bar .slot" gives ".slot"). A bare tag is too generic to look up.
  function leadToken(sel) {
    var ab = document.getElementById("action_bar"), parts = sel.trim().split(/[\s>+~]+/);
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].replace(/::?[\w-]+(\([^)]*\))?/g, "");
      if (!/[.#]/.test(t)) continue;
      var list = null;
      try { list = document.querySelectorAll(t); } catch (e) { return null; }
      var above = false;
      for (var j = 0; ab && j < list.length; j++) if (list[j] === ab || list[j].contains(ab)) above = true;
      if (!above) return t;
    }
    return null;
  }
  function sheetTokens(hrefRe) {
    var key = String(hrefRe);
    if (tokenCache[key]) return tokenCache[key];
    var out = [], seen = {};
    try {
      for (var s = 0; s < document.styleSheets.length; s++) {
        var sh = document.styleSheets[s], rules = null;
        if (!hrefRe.test(sh.href || "")) continue;
        try { rules = sh.cssRules || sh.rules; } catch (e) { }
        if (!rules) continue;
        for (var r = 0; r < rules.length; r++) {
          String(rules[r].selectorText || "").split(",").forEach(function (sel) {
            var t = leadToken(sel);
            if (!t || seen[t]) return;
            seen[t] = true;
            out.push(t);
          });
        }
      }
    } catch (e) { dbg("stylesheet read failed: " + e); }
    if (out.length) tokenCache[key] = out;
    return out;
  }
  function matchAll(tokens, scope) {
    var out = [];
    tokens.forEach(function (t) {
      var list = null;
      try { list = scope.querySelectorAll(t); } catch (e) { return; }
      for (var i = 0; i < list.length; i++) if (out.indexOf(list[i]) < 0) out.push(list[i]);
    });
    return out;
  }
  function outermost(list) {
    return list.filter(function (n) {
      for (var i = 0; i < list.length; i++) if (list[i] !== n && list[i].contains(n)) return false;
      return true;
    });
  }
  function shown(n) {
    try { return n.offsetWidth > 0 || n.offsetHeight > 0; } catch (e) { return false; }
  }
  function findStockBar() {
    var ab = document.getElementById("action_bar");
    if (!ab) return { els: [], cons: [], sels: "no #action_bar" };
    var toolT = sheetTokens(/action_bar\/css\/tool_bar\.css/i);
    var consT = sheetTokens(/action_bar\/css\/consumable_bar\.css/i).filter(function (t) { return toolT.indexOf(t) < 0; });
    var cons = outermost(matchAll(consT, ab));
    var els = outermost(matchAll(toolT, ab).filter(function (n) {
      if (n === ab || n.contains(ab) || root.contains(n)) return false;
      for (var i = 0; i < cons.length; i++) if (cons[i] === n || cons[i].contains(n) || n.contains(cons[i])) return false;
      return true;
    }));
    return {
      els: els, cons: cons,
      sels: els.map(describe).join(", ") + " (from " + toolT.length + " tool_bar.css selector(s), " + consT.length + " consumable_bar.css)",
    };
  }
  function cssHide(found, trigger) {
    var n = 0;
    found.els.forEach(function (e) {
      if (e.style.display === "none") return;
      if (e.__twDisplay === undefined) e.__twDisplay = e.style.display;
      e.style.display = "none";
      n++;
    });
    bar.els = found.els;
    var line = "stock bar hidden via css display:none on " + found.sels;
    if (n && (line !== bar.lastLog || debug)) { bar.lastLog = line; log(line + " (" + n + " element(s), at " + trigger + ")"); }
  }
  function hideStockBar(trigger) {
    if (!CFG.hideStockBar || state.disposed || bar.trying) return;
    var found = findStockBar();
    if (!found.els.length) {
      if (bar.lastLog !== "none") { bar.lastLog = "none"; log("stock bar NOT hidden: no tool bar element found in #action_bar (" + found.sels + ", at " + trigger + ")"); }
      return;
    }
    if (bar.how === "css") { cssHide(found, trigger); return; }
    var tb = window.toolbar;
    if (bar.how === "visible" && !tb) bar.how = "css";
    if (bar.how === "css") { cssHide(found, trigger); return; }
    if (bar.how === "visible") {
      if (tb.visible !== false) { tb.visible = false; dbg("window.toolbar.visible was reset to true by the HUD; set false again at " + trigger); }
      if (found.els.some(shown)) { log("window.toolbar.visible = false no longer hides the bar; switching to css"); bar.how = "css"; cssHide(found, trigger); }
      return;
    }
    // First time: try window.toolbar.visible, measure, then decide.
    var before = found.els.some(shown), consBefore = found.cons.map(shown);
    if (!tb || typeof tb.visible !== "boolean" || !before) {
      bar.how = "css";
      if (tb && typeof tb.visible === "boolean") dbg("window.toolbar.visible not tried: the tool bar is not shown right now (at " + trigger + ")");
      cssHide(found, trigger);
      return;
    }
    bar.trying = true;
    try { tb.visible = false; } catch (e) { dbg("window.toolbar.visible = false threw " + e); }
    setTimeout(function () {
      bar.trying = false;
      if (state.disposed) return;
      var f2 = findStockBar(), still = f2.els.some(shown), consNow = f2.cons.map(shown);
      var consSame = consNow.length === consBefore.length && consNow.every(function (v, i) { return v === consBefore[i]; });
      if (!still && consSame) {
        bar.how = "visible";
        bar.els = f2.els;
        log("stock bar hidden via window.toolbar.visible = false (" + f2.sels + " now not shown; consumable bar unchanged)");
      } else {
        try { tb.visible = true; } catch (e) { }
        log("window.toolbar.visible = false " + (still ? "did not hide the tool bar" : "also changed the consumable bar") + "; reverted, using css");
        bar.how = "css";
        cssHide(f2, trigger);
      }
    }, 200);
  }
  function stockBarSoon(trigger) {
    if (!CFG.hideStockBar || bar.timer) return;
    bar.timer = setTimeout(function () { bar.timer = null; if (!state.disposed) hideStockBar(trigger); }, 60);
  }
  function watchStockBar() {
    if (!CFG.hideStockBar) return;
    var ab = document.getElementById("action_bar");
    if (ab && typeof MutationObserver === "function") {
      try {
        bar.observer = new MutationObserver(function () { stockBarSoon("re-render"); });
        bar.observer.observe(ab, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
        dbg("stock bar: MutationObserver on #action_bar");
      } catch (e) { bar.observer = null; dbg("stock bar: MutationObserver failed: " + e); }
    }
    // Fallback (and a safety net for a re-created #action_bar): re-check every 2 s.
    bar.poll = setInterval(function () { if (!state.disposed) hideStockBar("poll"); }, 2000);
    hideStockBar("load");
  }
  function showStockBar() {
    try { if (bar.observer) bar.observer.disconnect(); } catch (e) { }
    if (bar.poll) clearInterval(bar.poll);
    if (bar.how === "visible") { try { window.toolbar.visible = true; } catch (e) { } }
    bar.els.forEach(function (e) { if (e.__twDisplay !== undefined) { e.style.display = e.__twDisplay; e.__twDisplay = undefined; } });
  }

  // ---------------------------------------------------------------- inventory: hide tools
  // HideToolsInInventory: the tools the wheel lists are hidden in the inventory / nanopack
  // window, client side only (the items stay in the nanopack; the wheel loads them from there).
  // [unproven] The inventory's DOM is not known: the HUD sources are packed and no dump of
  // an open inventory exists yet. So nothing is assumed about its classes. A tile is found from
  // its icon: an <img> src or inline background-image naming one of the wheel's tool icons,
  // outside #action_bar and the wheel. The tile is the nearest ancestor with at least two
  // siblings of the same tag and class (one entry of a list or grid), and it must sit inside an
  // element whose id or class names an inventory (inventor / nanopack / container / item_).
  // Every match is logged with its ancestor chain, so the selectors can be pinned later. If
  // pressing I finds no tool icon in this view, the inventory is a separate Coherent view the
  // injected script cannot reach, and the log says so.
  var inv = { hidden: [], observer: null, timer: null, lastLog: "", dumped: {} };
  var INV_RE = /inventor|nanopack|container|item_/i;
  function toolIconSet() {
    var set = {};
    ["explore", "build"].forEach(function (g) {
      (state.tools[g] || []).forEach(function (t) { if (t.icon) set[String(t.icon).toLowerCase()] = t.name; });
    });
    return set;
  }
  function iconOf(n) {
    var src = n.tagName === "IMG" ? (n.getAttribute("src") || "") : (n.style && n.style.backgroundImage) || "";
    var m = src.match(/iconsLib\/misclib\/([^"')?]+)/i);
    return m ? m[1].toLowerCase() : null;
  }
  function sameSiblings(n) {
    var p = n.parentNode, c = cls(n), k2 = 0;
    if (!p || !p.children) return 0;
    for (var i = 0; i < p.children.length; i++) if (p.children[i].tagName === n.tagName && cls(p.children[i]) === c) k2++;
    return k2;
  }
  function chain(n) {
    var out = [];
    for (var a = n; a && a !== document.body && out.length < 12; a = a.parentNode) out.push(describe(a));
    return out.reverse().join(" > ");
  }
  function scanInventory(trigger, report) {
    if (!CFG.hideToolsInInventory || state.disposed) return;
    var icons = toolIconSet(), ab = document.getElementById("action_bar");
    var cand = [], i;
    try { var imgs = document.getElementsByTagName("img"); for (i = 0; i < imgs.length; i++) cand.push(imgs[i]); } catch (e) { }
    try { var bgs = document.querySelectorAll("[style*='iconsLib']"); for (i = 0; i < bgs.length; i++) cand.push(bgs[i]); } catch (e) { }
    var tiles = [], outside = 0, sels = {};
    cand.forEach(function (n) {
      var ic = iconOf(n);
      if (!ic || !icons[ic] || root.contains(n) || (ab && ab.contains(n))) return;
      outside++;
      var tile = null, list = null;
      for (var a = n; a && a !== document.body; a = a.parentNode) {
        if (!tile && a !== n && sameSiblings(a) >= 3) tile = a;
        if (tile && (INV_RE.test(cls(a)) || INV_RE.test(a.id || ""))) { list = a; break; }
      }
      var key = ic + "|" + (tile ? describe(tile) : "-");
      if (debug && !inv.dumped[key]) { inv.dumped[key] = true; dbg("inventory: tool icon " + ic + " (" + icons[ic] + ") at " + chain(n) + (tile ? "; tile " + describe(tile) : "; no list tile") + (list ? " in " + describe(list) : "; no inventory-like ancestor, left alone")); }
      if (tile && list && tiles.indexOf(tile) < 0) { tiles.push(tile); sels[describe(list) + " " + describe(tile)] = true; }
    });
    // Tiles that no longer show a tool (a recycled list entry) come back.
    inv.hidden = inv.hidden.filter(function (t) {
      if (tiles.indexOf(t) >= 0 && t.parentNode) return true;
      if (t.__twDisplay !== undefined) { t.style.display = t.__twDisplay; t.__twDisplay = undefined; }
      return false;
    });
    var added = 0;
    tiles.forEach(function (t) {
      if (t.style.display === "none") return;
      if (t.__twDisplay === undefined) t.__twDisplay = t.style.display;
      t.style.display = "none";
      if (inv.hidden.indexOf(t) < 0) inv.hidden.push(t);
      added++;
    });
    var how = Object.keys(sels).join(" | ");
    if (added || report) {
      var line = tiles.length
        ? "inventory: hid " + tiles.length + " tool entries via " + how + " (at " + trigger + ")"
        : outside
          ? "[unproven] inventory: " + outside + " tool icon(s) outside the tool bar, none in an inventory-like list; nothing hidden (debug lines above show where)"
          : "[unproven] inventory: no tool icon anywhere in the HUD view after " + trigger + "; the inventory is likely a separate view this script cannot reach, so nothing is hidden";
      if (line !== inv.lastLog || report) { inv.lastLog = line; log(line); }
    }
  }
  function inventorySoon(trigger) {
    if (!CFG.hideToolsInInventory || inv.timer) return;
    inv.timer = setTimeout(function () { inv.timer = null; scanInventory(trigger, false); }, 250);
  }
  function inventoryKeyCheck() {
    if (!CFG.hideToolsInInventory) return;
    setTimeout(function () { scanInventory("I pressed", true); }, 900);
  }
  function watchInventory() {
    if (!CFG.hideToolsInInventory) return;
    if (typeof MutationObserver === "function") {
      try {
        inv.observer = new MutationObserver(function (recs) {
          for (var i = 0; i < recs.length; i++) {
            var t = recs[i].target;
            if (root.contains(t)) continue;
            inventorySoon("re-render");
            return;
          }
        });
        inv.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
        dbg("inventory: MutationObserver on body");
      } catch (e) { inv.observer = null; log("inventory: MutationObserver failed (" + e + "); checked on I and on tool data only"); }
    } else log("inventory: no MutationObserver in this HUD; checked on I and on tool data only");
  }
  function showInventoryTools() {
    try { if (inv.observer) inv.observer.disconnect(); } catch (e) { }
    inv.hidden.forEach(function (t) { if (t.__twDisplay !== undefined) { t.style.display = t.__twDisplay; t.__twDisplay = undefined; } });
    inv.hidden = [];
  }

  // ---------------------------------------------------------------- G (stock holster)
  // G puts the equipped tool away: the client sends ClearContentOfToolBar(-1) and
  // DeselectCurrentToolOfToolBar. A second G should take it back out, but in the 18:23 log the
  // second G produced no toolbar event at all, and no wheel line: the slot-key and quick-select
  // guards arm only on the wheel's own keys and never on G. So the wheel remembers the tool G put
  // away and, on the next G with nothing equipped, re-selects it itself when the stock binding
  // has not re-equipped anything within 300 ms.
  var G_CODE = 71;
  var holster = { id: "", down: false, at: 0 };
  function toolName(id) { var t = findTool(id); return t ? t.name : "type " + id; }
  function holsterKey(e) {
    if (e.type === "keyup") { holster.down = false; return; }
    if (e.type !== "keydown") return;
    var now = Date.now();
    if (holster.down && now - holster.at < 1000) return; // auto-repeat while held
    holster.down = true;
    holster.at = now;
    seedLiveBar();
    var cur = state.selectedSlot;
    if (cur >= 0) {
      var id = state.live[cur] || "";
      if (id) holster.id = id;
      log("G: putting away " + (id ? toolName(id) : "an unknown tool") + " (slot " + (cur + 1) + "); the next G takes it back out");
      return;
    }
    if (!holster.id) { log("G: nothing equipped and no tool put away by G yet; left to the game"); return; }
    if (isBusy()) { log("G: a wheel pick is in flight; the G re-equip stands down"); return; }
    var want = holster.id;
    setTimeout(function () {
      if (state.disposed) return;
      if (isBusy()) { log("G: a wheel pick started; the G re-equip stands down"); return; }
      if (state.lastSelectEventAt >= now || state.selectedSlot >= 0) {
        log("G: the game re-equipped slot " + (state.selectedSlot + 1) + " by itself");
        return;
      }
      var tool = findTool(want), s = liveSlotOf(want);
      if (!tool) { log("G: the game did nothing in 300 ms, and " + toolName(want) + " is no longer in the tool list; nothing to re-equip"); return; }
      log("G: the game did nothing in 300 ms; re-equipping " + tool.name + (s >= 0 ? " from slot " + (s + 1) : " (not on the bar, loading it)"));
      choose(tool, false);
    }, 300);
  }

  // ---------------------------------------------------------------- binding trace (debug only)
  // Logs every call into the toolBar binding, the stock tool bar view (window.toolbar) and the
  // CPP inventory / storage / container / item bindings: arguments with their types, and the
  // return value. Also engine.call / engine.trigger traffic whose name looks tool- or
  // inventory-related, and the inventory tile a mouse press or drag starts on. Purpose: see
  // exactly what the stock UI calls when the player drags a tool from the inventory onto the
  // tool bar. Calls pass through unchanged (same this, same arguments, same return value; a
  // throw is logged and rethrown). "by wheel" marks the wheel's own calls (tb()).
  var trace = { on: false, wrapped: [], counts: {}, timer: null, inLog: false, listeners: [] };
  var TRACE_OBJ_RE = /^CPP\w*(inventor|storage|container|item|toolbar)/i;
  var TRACE_EVT_RE = /tool|inventor|storage|container|item|slot|drag|drop|nanopack/i;
  var TRACE_PER_10S = 20;
  function tlog(msg) {
    trace.inLog = true;
    try { console.log(TAG + "[trace] " + msg); } catch (e) { }
    try { forward("[trace] " + msg); } finally { trace.inLog = false; }
  }
  function typed(v) {
    var t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    var s;
    if (t === "string") s = JSON.stringify(v.length > 300 ? v.substring(0, 300) + "..." : v);
    else if (t === "function") s = "fn " + (v.name || "anonymous");
    else s = short(v, 300);
    return s + ":" + t;
  }
  // At most TRACE_PER_10S lines per function per 10 s; the rest are counted and summarised.
  function traceLine(key, make) {
    var n = trace.counts[key] = (trace.counts[key] || 0) + 1;
    if (n <= TRACE_PER_10S) tlog(make());
  }
  function wrapFn(obj, objName, name, filter) {
    var orig;
    try { orig = obj[name]; } catch (e) { return false; }
    if (typeof orig !== "function" || orig.__twTraced) return false;
    var key = objName + "." + name;
    var w = function () {
      if (trace.inLog || !live() || (filter && !filter(arguments))) return orig.apply(this, arguments);
      var a = Array.prototype.slice.call(arguments), by = ownCall > 0 ? "wheel" : "stock";
      function call() { return key + "(" + a.map(typed).join(", ") + ") by " + by; }
      var r;
      try { r = orig.apply(this, arguments); }
      catch (e) { traceLine(key, function () { return call() + " THREW " + e; }); throw e; }
      traceLine(key, function () { return call() + " -> " + typed(r); });
      if (r && typeof r.then === "function") {
        try { r.then(function (v) { traceLine(key, function () { return call() + " resolved " + typed(v); }); }); } catch (e) { }
      }
      return r;
    };
    w.__twTraced = true;
    try { obj[name] = w; } catch (e) { }
    if (obj[name] !== w) {
      try { Object.defineProperty(obj, name, { value: w, configurable: true, writable: true, enumerable: true }); } catch (e) { }
    }
    if (obj[name] !== w) return false;
    trace.wrapped.push({ obj: obj, name: name, orig: orig, w: w });
    return true;
  }
  function wrapAll(obj, objName, done, failed) {
    var names = {}, o = obj, d = 0;
    while (o && o !== Object.prototype && o !== Function.prototype && d < 3) {
      try { Object.getOwnPropertyNames(o).forEach(function (n) { names[n] = true; }); } catch (e) { }
      o = Object.getPrototypeOf(o);
      d++;
    }
    Object.keys(names).sort().forEach(function (n) {
      if (n === "constructor") return;
      var desc = null;
      for (var p = obj; p && !desc; p = Object.getPrototypeOf(p)) { try { desc = Object.getOwnPropertyDescriptor(p, n); } catch (e) { break; } }
      if (desc && (desc.get || desc.set)) return; // accessors: not called here
      var f; try { f = obj[n]; } catch (e) { return; }
      if (typeof f !== "function") return;
      (wrapFn(obj, objName, n) ? done : failed).push(objName + "." + n);
    });
  }
  // The inventory tile under a mouse press or drag: index in its list, attributes, and the
  // stock component's own properties on the element (where the client may keep the item's slot).
  function tileOf(n) {
    for (var a = n; a && a !== document.body; a = a.parentNode) {
      if (a.tagName === "LI" && /item_slot/.test(cls(a))) return a;
    }
    return null;
  }
  function tileInfo(t) {
    var out = [], p = t.parentNode, idx = -1, total = 0;
    if (p && p.children) for (var i = 0; i < p.children.length; i++) { if (p.children[i].tagName === "LI") { if (p.children[i] === t) idx = total; total++; } }
    out.push("list index " + idx + " of " + total);
    try { for (var k = 0; k < t.attributes.length; k++) out.push("@" + t.attributes[k].name + "=" + JSON.stringify(t.attributes[k].value)); } catch (e) { }
    var ic = null, kids = t.getElementsByTagName("*");
    for (var j = 0; j < kids.length && !ic; j++) ic = iconOf(kids[j]);
    out.push("icon " + (ic || "none"));
    var own = [];
    try {
      Object.keys(t).forEach(function (k2) {
        var v = t[k2];
        if (v && typeof v === "object" && !(v instanceof Node)) {
          var sub = [];
          try {
            Object.keys(v).slice(0, 25).forEach(function (k3) {
              var x = v[k3];
              if (x === null || (typeof x !== "object" && typeof x !== "function")) sub.push(k3 + "=" + typed(x));
              else sub.push(k3 + ":" + (Array.isArray(x) ? "array" : typeof x));
            });
          } catch (e) { }
          own.push(k2 + "{" + sub.join(" ") + "}");
        } else if (typeof v !== "function") own.push(k2 + "=" + typed(v));
      });
    } catch (e) { }
    out.push("expandos " + (own.length ? own.join(" ") : "none"));
    return short(out.join("; "), 1500);
  }
  function onTraceMouse(e) {
    var t = tileOf(e.target);
    if (!t) return;
    tlog("dom " + e.type + " on inventory tile: " + tileInfo(t));
  }
  // On I: every tool tile in the inventory grid, with where the client puts it.
  function traceInventoryTiles() {
    var icons = toolIconSet(), ab = document.getElementById("action_bar"), seen = [], lines = 0;
    var all = document.getElementsByTagName("*");
    for (var i = 0; i < all.length && lines < 25; i++) {
      var n = all[i], ic = iconOf(n);
      if (!ic || !icons[ic] || root.contains(n) || (ab && ab.contains(n))) continue;
      var t = tileOf(n);
      if (!t || seen.indexOf(t) >= 0) continue;
      seen.push(t);
      tlog("inventory tile " + icons[ic] + ": " + tileInfo(t));
      lines++;
    }
    if (!lines) tlog("inventory tiles: no tool tile in the HUD view after I");
  }
  function installTrace() {
    if (trace.on || state.disposed) return;
    trace.on = true;
    var done = [], failed = [], objs = [];
    if (typeof toolBar !== "undefined") wrapAll(toolBar, "toolBar", done, failed);
    if (window.toolbar && typeof window.toolbar === "object") wrapAll(window.toolbar, "toolbar", done, failed);
    try {
      Object.getOwnPropertyNames(window).forEach(function (n) {
        if (!TRACE_OBJ_RE.test(n) || n === "CPPMod") return;
        var v; try { v = window[n]; } catch (e) { return; }
        if (!v || typeof v !== "object") return;
        objs.push(n);
        wrapAll(v, n, done, failed);
      });
    } catch (e) { tlog("window scan failed: " + e); }
    try {
      var inv2 = Object.getOwnPropertyNames(window).filter(function (n) { return /inventor|storage|itemset/i.test(n); });
      tlog("window globals inventory/storage/itemset: " + (inv2.length ? inv2.map(function (n) { var v; try { v = window[n]; } catch (e) { } return n + ":" + typeof v; }).join(" ") : "none"));
    } catch (e) { }
    if (typeof engine !== "undefined") {
      var evName = function (a) { var n = a[0]; return typeof n === "string" && n.indexOf("ToolWheel.") !== 0 && TRACE_EVT_RE.test(n); };
      ["call", "trigger", "_trigger"].forEach(function (n) {
        if (typeof engine[n] === "function") (wrapFn(engine, "engine", n, evName) ? done : failed).push("engine." + n);
      });
    }
    ["mousedown", "dragstart", "drop", "dragend"].forEach(function (type) {
      document.addEventListener(type, onTraceMouse, true);
      trace.listeners.push(type);
    });
    trace.timer = setInterval(function () {
      Object.keys(trace.counts).forEach(function (k) {
        if (trace.counts[k] > TRACE_PER_10S) tlog(k + ": " + trace.counts[k] + " calls in the last 10 s, " + TRACE_PER_10S + " logged");
      });
      trace.counts = {};
    }, 10000);
    tlog("on: wrapped " + done.length + " function(s) [" + short(done.join(" "), 1500) + "]" +
      (failed.length ? "; could not wrap " + failed.join(" ") : "") + "; CPP objects " + (objs.length ? objs.join(" ") : "none"));
  }
  function uninstallTrace() {
    if (!trace.on) return;
    trace.on = false;
    trace.wrapped.forEach(function (x) { try { if (x.obj[x.name] === x.w) x.obj[x.name] = x.orig; } catch (e) { } });
    trace.wrapped = [];
    trace.listeners.forEach(function (type) { try { document.removeEventListener(type, onTraceMouse, true); } catch (e) { } });
    trace.listeners = [];
    if (trace.timer) { clearInterval(trace.timer); trace.timer = null; }
    try { console.log(TAG + "[trace] off"); } catch (e) { }
  }

  // ---------------------------------------------------------------- debug probes
  function props(obj) {
    if (obj === null || obj === undefined) return String(obj);
    var names = {}, o = obj, depth = 0;
    while (o && o !== Object.prototype && depth < 3) {
      try { Object.getOwnPropertyNames(o).forEach(function (n) { names[n] = true; }); } catch (e) { }
      o = Object.getPrototypeOf(o);
      depth++;
    }
    return Object.keys(names).sort().map(function (n) {
      var t;
      try { t = typeof obj[n]; } catch (e) { t = "?"; }
      return n + ":" + t;
    }).join(" ");
  }
  function probe() {
    dbg("probe v" + VERSION + ": toolBar.changeItem=" + typeof toolBar.changeItem + " toolBar.checkItem=" + typeof toolBar.checkItem +
      " CPPHud.toggleEnhancedMouse=" + typeof CPPHud.toggleEnhancedMouse + " CPPHud.getNameFromTypeId=" + typeof CPPHud.getNameFromTypeId);
    // The stock toolbar view object (window.toolbar) and its DOM, for a closer match later.
    try { dbg("props window.toolbar: " + short(props(window.toolbar), 1500) + "; visible=" + (window.toolbar ? window.toolbar.visible : "n/a")); } catch (e) { }
    try { dbg("props toolBar: " + short(props(toolBar), 1500)); } catch (e) { }
    try {
      var abn = document.getElementById("action_bar"), tree = [];
      (function walk(n, d) {
        if (!n || d > 4 || tree.length > 60) return;
        for (var c = n.firstElementChild; c; c = c.nextElementSibling) { tree.push(d + ":" + describe(c)); walk(c, d + 1); }
      })(abn, 0);
      dbg("#action_bar tree: " + short(tree.join(" "), 1800));
    } catch (e) { dbg("#action_bar tree failed: " + e); }
    try { var fb = findStockBar(); dbg("stock tool bar elements: " + fb.sels + "; consumable bar: " + fb.cons.map(describe).join(", ")); } catch (e) { }
    try { dbg("#action_bar html: " + short((document.getElementById("action_bar") || {}).outerHTML || "none", 1800)); } catch (e) { }
    // Is there a stock radial / pie component to reuse?
    try {
      var g = Object.getOwnPropertyNames(window).filter(function (n) { return /radial|pie_?menu|wheel_?menu|circular|context_?menu/i.test(n) && n !== "oncontextmenu"; });
      dbg("window globals radial/wheel/context menu: " + (g.length ? g.join(" ") : "none"));
    } catch (e) { }
    try {
      var hits = {}, all = document.getElementsByTagName("*");
      for (var i = 0; i < all.length; i++) {
        var c = cls(all[i]) + " " + (all[i].id || "");
        var m = c.match(/[\w-]*(radial|pie_|wheel|circular|context_?menu)[\w-]*/i);
        if (m && !root.contains(all[i])) hits[m[0]] = (hits[m[0]] || 0) + 1;
      }
      dbg("DOM classes/ids radial/wheel/context menu: " + (Object.keys(hits).length ? short(hits, 800) : "none"));
    } catch (e) { }
    try {
      var sheets = [], sel = {};
      for (var s = 0; s < document.styleSheets.length; s++) {
        var sh = document.styleSheets[s], rules = null;
        try { rules = sh.cssRules || sh.rules; } catch (e) { }
        sheets.push((sh.href || "inline") + "(" + (rules ? rules.length : "?") + ")");
        if (rules) for (var r = 0; r < rules.length; r++) {
          var st = rules[r].selectorText || "";
          if (/radial|wheel|pie_|circular|context_?menu/i.test(st)) sel[st] = true;
        }
      }
      for (var q = 0; q < sheets.length; q += 12) dbg("stylesheets " + q + ": " + sheets.slice(q, q + 12).join(" "));
      dbg("stylesheet selectors radial/wheel/context menu: " + (Object.keys(sel).length ? short(Object.keys(sel).join(" | "), 1500) : "none"));
    } catch (e) { dbg("stylesheet scan failed: " + e); }
    readIconBase();
    dbg("icons from " + iconBase + "; stock bar icons " + short(stockBarIcons().join(" "), 600));
  }

  // ---------------------------------------------------------------- lifecycle
  state.dispose = function () {
    if (state.disposed && !root.parentNode) return;
    state.disposed = true;
    if (state.pending && state.pending.timer) clearTimeout(state.pending.timer);
    state.pending = null;
    if (modeTimer) clearTimeout(modeTimer);
    if (bar.timer) clearTimeout(bar.timer);
    if (inv.timer) clearTimeout(inv.timer);
    try { uninstallTrace(); } catch (e) { }
    close("replaced");
    showStockBar();
    showInventoryTools();
    try { document.removeEventListener("keydown", onKey, true); document.removeEventListener("keyup", onKey, true); } catch (e) { }
    try { root.parentNode.removeChild(root); } catch (e) { }
    try { if (state.icon && hudManager.removeNotificationIcon) hudManager.removeNotificationIcon(state.icon); } catch (e) { }
  };
  state.choose = choose; // for the ModAdmin eval box: __toolWheel.choose(tool)
  state.hello = function (why) {
    send(A_HELLO, JSON.stringify({
      v: VERSION, instance: INSTANCE, why: why, debug: debug, page: !!page, icon: !!state.icon,
      changeItem: typeof toolBar !== "undefined" ? typeof toolBar.changeItem : "missing",
      hotkey: CFG.enableHotkey ? hot.label + " (keyCode " + hotCode + (hot.custom ? ", own" : "") + ")" : "off", holdAlt: !!CFG.holdAlt,
      font: font ? font.family : null, hideStockBar: !!CFG.hideStockBar, stockBarHiddenVia: bar.how,
      hideToolsInInventory: !!CFG.hideToolsInInventory, singleSlot: SINGLE ? D + 1 : false,
      quickKeys: QUICK.map(function (q) { return q.label + "=" + q.code; }).join(" "),
    }));
  };

  log("loaded v" + VERSION + ", instance " + INSTANCE + " (hotkey " + (CFG.enableHotkey ? CFG.hotkey + ", keyCode " + hotCode : "off") + ", hold Alt " + (CFG.holdAlt ? "on" : "off") +
    ", single-slot bar " + (SINGLE ? "slot " + (D + 1) : "off") + ", hide stock bar " + (CFG.hideStockBar ? "on" : "off") + ", hide tools in inventory " + (CFG.hideToolsInInventory ? "on" : "off") +
    ", quick keys " + (QUICK.length ? QUICK.map(function (q) { return q.label; }).join(" ") : "off") + ", debug " + (debug ? "on" : "off") + ")");
  if (debug) { try { probe(); } catch (e) { dbg("probe failed: " + e); } }
  if (debug) { try { installTrace(); } catch (e) { log("trace install failed: " + e); } }
  try { watchStockBar(); } catch (e) { log("stock bar hide failed: " + e); }
  try { watchInventory(); } catch (e) { log("inventory hide failed: " + e); }
  state.hello("load");
})();
