// Single-slot bar simulation. The native toolbar model follows the Dual.exe disassembly:
// select(i) toggles (i == selected -> -1); selecting an empty slot unequips; resetItem(i) unequips a
// selected slot, empties it and fires ClearContentOfToolBar(i). Event order as in the client logs.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const dom = new JSDOM(`<body><div id="action_bar"></div></body>`, { runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
const handlers = {};
const out = [];
w.console.log = (m) => out.push(m);
w.console.error = (m) => out.push("ERR " + m);
w.engine = { on: (n, f) => (handlers[n] = handlers[n] || []).push(f), call() {}, trigger() {} };
const fire = (n, ...a) => (handlers[n] || []).forEach((f) => f(...a));
const later = (f) => setTimeout(f, 2);
w.CPPMod = { sendModAction: (m, id, c, p) => {} };
w.CPPHud = { toggleEnhancedMouse: () => {}, addFailureNotification: (t) => out.push("NOTIFY " + t) };
w.MousePage = class { show(v) { this.isVisible = v; } _onVisibilityChange() {} };
w.NotificationIconComponent = class { constructor() { this.onClickEvent = { subscribe: () => {} }; this.HTMLNodes = { icon: {} }; } };
w.hudManager = { addNotificationIcon() {} };
w.HTMLCanvasElement.prototype.getContext = () => null;

// nanopack: slot -> type (tools parked at 1000+)
const T = { H: "2687779164", B: "1831253859", M: "3206985070", Man: "1413330661", PS: "3906188322", R: "778071808", S: "2865455409",
  El: "823239531", Vx: "2798413040", Ln: "3533377567", AS: "2799405554", Sm: "2137208509" };
const nanopack = {}; let s = 1000; for (const k in T) nanopack[s++] = T[k];
const slotOf = (id) => Number(Object.keys(nanopack).find((k) => nanopack[k] === id));
const nat = { bar: [], selected: -1, saves: 0 };
function setSelected(i) {
  if (nat.selected === i) return;
  const had = nat.selected >= 0 && nat.bar[nat.selected];
  nat.selected = i;
  if (i >= 0 && nat.bar[i]) later(() => fire("SelectToolOfToolBar", i));
  else if (had) later(() => { fire("ClearContentOfToolBar", -1); fire("DeselectCurrentToolOfToolBar"); });
}
w.toolBar = {
  selectItem: (i) => setSelected(nat.selected === i ? -1 : i),
  resetItem: (i) => { if (nat.selected === i) setSelected(-1); if (nat.bar[i]) { nat.bar[i] = ""; nat.saves++; later(() => fire("ClearContentOfToolBar", i)); } },
  changeItem: (i, sid, slot) => {
    if (sid !== "0" || !nanopack[slot]) { out.push("NATIVE changeItem rejected " + i + "," + sid + "," + slot); return; }
    nat.bar[i] = nanopack[slot]; nat.saves++;
    later(() => fire("SetContentOfToolBar", i, JSON.stringify({ instanceId: "0", ownerId: { organizationId: 0, playerId: 0 }, typeId: nat.bar[i] }), []));
  },
  checkItem: () => true, swapItems: () => {},
};
const name = {}; for (const k in T) name[T[k]] = k;
const show = () => "[" + nat.bar.map((t, i) => (t ? name[t] : "_") + (i === nat.selected ? "*" : "")).join(" ") + "]";
function loadBar(types, sel) {
  nat.bar = types.slice(); nat.selected = sel;
  fire("InitializeToolBar", 9);
  types.forEach((t, i) => t ? fire("SetContentOfToolBar", i, JSON.stringify({ typeId: t }), []) : fire("ClearContentOfToolBar", i));
  if (sel >= 0) fire("SelectToolOfToolBar", sel);
}
function key(code) {
  const kd = new w.KeyboardEvent("keydown", {}); Object.defineProperty(kd, "keyCode", { value: code });
  w.document.dispatchEvent(kd);
  const ku = new w.KeyboardEvent("keyup", {}); Object.defineProperty(ku, "keyCode", { value: code });
  // native binding runs after the HUD copy
  if (code >= 49 && code <= 57) w.toolBar.selectItem(code - 49);
  if (code === 71 && nat.selected >= 0) setSelected(-1);
  w.document.dispatchEvent(ku);
}
const tool = (k, g) => ({ id: T[k], name: k, label: k, icon: k + ".png", tooltip: "", slot: slotOf(T[k]) });
const data = { source: "nanopack", tools: { explore: ["H", "B", "M", "Man", "PS", "R", "S"].map((k) => tool(k)), build: ["El", "Vx", "Ln", "AS", "Sm"].map((k) => tool(k)) }, bars: { explore: [], build: [] } };

const src = fs.readFileSync(process.argv[2], "utf8")
  .replace("__TOOLWHEEL_CONFIG__", JSON.stringify({ hotkey: "4", enableHotkey: true, hotkeyCode: 52, loadSlot: 8, singleSlot: true, quickKeys: [1,2,3,4,5,6,7,8,9].map(n=>({label:String(n),code:48+n})), debug: false, defaultBar: "explore", hideStockBar: false }))
  .replace("__TOOLWHEEL_VERSION__", "test");
w.eval(src);
fire("ToolWheel.data", JSON.stringify(data));

const steps = [];
const at = (ms, label, f) => steps.push([ms, label, f]);
const expect = [];
const check = (label, cond) => expect.push((cond() ? "PASS " : "FAIL ") + label + " " + show());
at(0, "login: explore bar full, Maneuver (slot 4) in hand", () => loadBar([T.H, T.B, T.M, T.Man, T.PS, T.R, T.S, "", ""], 3));
at(900, "", () => check("login normalised: only slot 9, Maneuver in hand", () => nat.bar.filter(Boolean).length === 1 && nat.bar[8] === T.Man && nat.selected === 8));
at(1000, "pick Mining", () => w.__toolWheel.choose(data.tools.explore[2]));
at(1600, "", () => check("Mining in slot 9 and in hand, nothing else", () => nat.bar.filter(Boolean).length === 1 && nat.bar[8] === T.M && nat.selected === 8));
at(1700, "stray key 3", () => key(51));
at(2300, "", () => check("stray 3: Mining back in hand", () => nat.selected === 8 && nat.bar[8] === T.M));
at(2400, "key 9 (own slot)", () => key(57));
at(2600, "", () => check("9 put Mining away", () => nat.selected === -1));
at(2700, "G", () => key(71));
at(3300, "", () => check("G re-equipped Mining", () => nat.selected === 8 && nat.bar[8] === T.M));
at(3400, "hotkey 4", () => key(52));
at(3900, "", () => check("4 opened the wheel and Mining is still in hand", () => w.__toolWheel.open && nat.selected === 8));
at(4000, "Esc", () => key(27));
at(4100, "pick Scanner while Mining held in slot 9", () => w.__toolWheel.choose(data.tools.explore[6]));
at(4800, "", () => check("Scanner replaced Mining in slot 9, in hand", () => nat.bar.filter(Boolean).length === 1 && nat.bar[8] === T.S && nat.selected === 8));
at(4900, "mode switch: build bar full, slot 4 selected", () => loadBar([T.El, T.Vx, T.Ln, T.AS, T.Sm, "", "", "", ""], 3));
at(5800, "", () => check("build bar normalised: AreaSmooth in slot 9 and in hand", () => nat.bar.filter(Boolean).length === 1 && nat.bar[8] === T.AS && nat.selected === 8));
at(5900, "mode switch: build bar, nothing in hand, tools in 1-2", () => loadBar([T.El, T.Vx, "", "", "", "", "", "", ""], -1));
at(6800, "", () => check("bar with nothing in hand: Element kept in slot 9, not equipped", () => nat.bar.filter(Boolean).length === 1 && nat.bar[8] === T.El && nat.selected === -1));
at(6900, "stray key 2 with nothing in hand", () => key(50));
at(7400, "", () => check("stray 2 with nothing in hand: still nothing in hand", () => nat.selected === -1 || nat.bar[nat.selected] === ""));
at(7500, "build bar: open wheel with 4, quick key 2 (Voxel)", () => { loadBar(["", "", "", "", "", "", "", "", T.AS], 8); setTimeout(() => { key(52); setTimeout(() => key(50), 300); }, 50); });
at(8900, "", () => check("quick 2 equipped Voxel in slot 9, alone", () => nat.bar.filter(Boolean).length === 1 && nat.bar[8] === T.Vx && nat.selected === 8));
steps.forEach(([ms, label, f]) => setTimeout(() => { if (label) out.push("--- " + label + "  " + show()); f(); }, ms));
setTimeout(() => {
  console.log(out.filter((l) => !/\[debug\]|font:|wheel drawn|scale:/.test(l)).join("\n"));
  console.log("\n" + expect.join("\n") + "\nsaves " + nat.saves);
  process.exit(expect.some((e) => e.startsWith("FAIL")) ? 1 : 0);
}, 9200);
