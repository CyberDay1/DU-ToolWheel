// Hotkey change simulation (hub > Change, Tool Wheel > Set hotkey / Reset hotkey), on the
// single-slot bar model of client_single_slot_sim.js.
// Single-slot bar simulation (setup copied). The native toolbar model follows the Dual.exe disassembly:
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
const server = { code: 52, own: false, asked: [] };
const refuse = { 71: "G is the holster key, which the wheel already handles", 27: "Esc cancels" };
function answer(result, extra) {
  const lbl = (c) => (c >= 48 && c <= 90 ? String.fromCharCode(c) : "key " + c);
  setTimeout(() => fire("ToolWheel.hotkey", JSON.stringify(Object.assign({ code: server.code, label: lbl(server.code), custom: server.own,
    configCode: 52, configLabel: "4", enabled: true, result }, extra || {}))), 5);
}
w.CPPMod = { sendModAction: (m, id, c, p) => {
  if (id !== 103) return;
  server.asked.push(p);
  if (p === "reset") { server.code = 52; server.own = false; answer("reset"); return; }
  const k = Number(p.slice(4));
  if (refuse[k]) { answer("refused", { reason: refuse[k], asked: k, askedLabel: String.fromCharCode(k) }); return; }
  server.code = k; server.own = true; answer("set", { asked: k });
} };
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


const tw = () => w.__toolWheel;
const hubText = () => w.document.getElementById("toolwheel_root").textContent;
function clickAct(act) {
  const all = w.document.getElementById("toolwheel_root").getElementsByTagName("span");
  for (const n of all) if (n.__twAct === act) { n.dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true, button: 0 })); return true; }
  out.push("NO BUTTON " + act); return false;
}
const steps = [];
const at = (ms, label, f) => steps.push([ms, label, f]);
const expect = [];
const check = (label, cond) => expect.push((cond() ? "PASS " : "FAIL ") + label + " " + show());
at(0, "login: Mining in slot 9, in hand", () => loadBar(["", "", "", "", "", "", "", "", T.M], 8));
at(100, "server sends the hotkey (info, default 4)", () => answer("info"));
at(300, "hotkey 4 opens", () => key(52));
at(500, "", () => check("4 opened the wheel; hub shows Hotkey 4 Change", () => tw().open && /Hotkey4Change/i.test(hubText().replace(/\s/g, ""))));
at(600, "click Change", () => clickAct("rebind"));
at(700, "", () => check("prompt shown", () => tw().rebind && /Press a key/.test(hubText())));
at(800, "press W (refused)", () => key(87));
at(900, "", () => check("W refused in the prompt, still waiting, nothing sent", () => tw().rebind && /cannot be the hotkey/.test(hubText()) && server.asked.length === 0));
at(1000, "press 5", () => key(53));
at(1500, "", () => check("5 saved, prompt closed, hub says set; stock slot-5 switch undone", () => !tw().rebind && server.asked[0] === "set:53" && /Hotkey set/.test(hubText()) && nat.selected === 8));
at(1600, "Esc", () => key(27));
at(1700, "4 (old hotkey)", () => key(52));
at(2300, "", () => check("4 no longer opens the wheel; Mining back in hand", () => !tw().open && nat.selected === 8));
at(2400, "5 (new hotkey)", () => key(53));
at(3000, "", () => check("5 opens the wheel; Mining still in hand", () => tw().open && nat.selected === 8 && /Hotkey5Change/i.test(hubText().replace(/\s/g, ""))));
at(3100, "5 again while open = wedge 5 quick key", () => key(53));
at(3900, "", () => check("5 while open picked wedge 5 (PS) and closed", () => !tw().open && nat.bar[8] === T.PS && nat.selected === 8));
at(4000, "menu: Set hotkey", () => fire("ToolWheel.rebind", "menu"));
at(4100, "", () => check("menu opened the wheel on the prompt", () => tw().open && tw().rebind));
at(4200, "Esc cancels the prompt only", () => key(27));
at(4300, "", () => check("Esc: prompt gone, wheel still open, hotkey still 5", () => tw().open && !tw().rebind && /Hotkey5Change/i.test(hubText().replace(/\s/g, ""))));
at(4400, "Change, then Backspace = reset", () => { clickAct("rebind"); setTimeout(() => key(8), 20); });
at(4700, "", () => check("Backspace reset to 4", () => server.asked[1] === "reset" && /Hotkey reset/.test(hubText())));
at(4800, "Esc closes", () => key(27));
at(4900, "4 opens again", () => key(52));
at(5400, "", () => check("4 opens after the reset", () => tw().open));
at(5500, "Esc; menu Reset hotkey while closed", () => { key(27); setTimeout(() => answer("reset"), 20); });
at(5800, "", () => check("menu reset with the wheel closed opens it on the result", () => tw().open && /Hotkey reset/.test(hubText())));
at(5900, "Change, then Cancel button", () => { clickAct("rebind"); setTimeout(() => clickAct("cancel"), 20); });
at(6100, "", () => check("Cancel button ends the prompt, wheel stays open", () => tw().open && !tw().rebind));
steps.forEach(([ms, label, f]) => setTimeout(() => { if (label) out.push("--- " + label + "  " + show()); f(); }, ms));
setTimeout(() => {
  console.log(out.filter((l) => !/\[debug\]|font:|wheel drawn|scale:/.test(l)).join("\n"));
  console.log("\n" + expect.join("\n") + "\nasked " + server.asked.join(" "));
  process.exit(expect.some((e) => e.startsWith("FAIL")) ? 1 : 0);
}, 6400);
