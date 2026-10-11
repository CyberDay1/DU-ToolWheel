"""End-to-end check of the equip paths in the real client script (src/client/toolwheel.js).

Same page and HUD stubs as render_impl.py, but the stock tool bar is emulated more closely:
- toolBar.changeItem(barIndex, storageIdStr, storageSlot) behaves as in Dual.exe: storage "0" is
  the nanopack, the third argument is the item's nanopack slot, and it answers with
  SetContentOfToolBar;
- toolBar.selectItem toggles like the stock bar (selecting the equipped slot unequips);
- the stock "tool bar slot N" binding fires 30 ms after a digit keydown, as in game.
The script is injected AFTER the toolbar events, like every re-injection in game, so it has to
fall back on the server's stored toolbar.

    python e2e_impl.py        # prints PASS/FAIL per step, exit code 1 on any failure
"""
import json
import math
import sys
from playwright.sync_api import sync_playwright

from render_impl import HERE, PAGE, QUICK_KEYS, ROAMING, SCRIPT, STUBS, compact, tools

ROAM = tools("explore")
# Nanopack slots as on the live server: the tools sit at 0..20 in wheel order, except HarvestTool,
# which experiment 5A moves to 300 (past the inventory grid).
for i, t in enumerate(ROAM):
    t["slot"] = i
BUILD_TOOLS = tools("build")
for i, t in enumerate(BUILD_TOOLS):
    t["slot"] = len(ROAM) + i
ROAM[0]["slot"] = 300
ID = {t["name"]: t["id"] for t in ROAM}
# Stored and live roaming bar, deliberately NOT in wheel order: Harvest, Refuel, Construct.
BAR = [ID["HarvestTool"], ID["RefuelTool"], ID["BlueprintTool"]]

BAR_STUB = """
window.__bar = { slots: ["", "", "", "", "", "", "", "", ""], sel: -1, calls: [], selects: [], changedAt: {} };
// Knobs, all as in game unless a test changes them:
// the item travels as a JSON STRING (10-09 18:50 log; an object only with __itemAsObject);
// the bar answers changeItem after __contentDelayMs (2 ms in the log);
// a select of a slot whose content changed less than __initDelayMs ago is ignored (a bar still
// initialising the slot: unproven in game, tested both ways); __dropSelects drops the next N selects.
window.__itemAsObject = false; window.__contentDelayMs = 2; window.__initDelayMs = 0; window.__dropSelects = 0;
window.__notes = [];
// The client's nanopack: slot -> type id. Set by the test from the tool list.
window.__nanopack = {};
// The server's answer to a "refresh" data request (ActionRequestData), set by the test.
window.__refreshData = null;
window.__dataRequests = [];
(function () {
  var base = CPPMod.sendModAction;
  CPPMod.sendModAction = function (m, id, a, p) {
    if (id === 101) {
      __dataRequests.push(p);
      if (p === "refresh" && __refreshData) setTimeout(function () { engine.trigger("ToolWheel.data", JSON.stringify(__refreshData)); }, 50);
    }
    return base(m, id, a, p);
  };
})();
CPPHud.addFailureNotification = function (t) { __notes.push(t); };
function __item(typeId) {
  var o = { instanceId: "0", ownerId: { organizationId: 0, playerId: 0 }, typeId: String(typeId) };
  return __itemAsObject ? o : JSON.stringify(o);
}
window.__setContent = function (slot, typeId) {
  __bar.slots[slot] = typeId; __bar.changedAt[slot] = Date.now();
  engine.trigger("SetContentOfToolBar", window.__slotAsString ? String(slot) : slot, __item(typeId), ["1909358165"]);
};
window.toolBar = {
  selectItem: function (i) {
    __bar.selects.push(i);
    if (__dropSelects > 0) { __dropSelects--; return; }
    if (__bar.changedAt[i] && Date.now() - __bar.changedAt[i] < __initDelayMs) return;
    if (__bar.sel === i) { __bar.sel = -1; engine.trigger("DeselectCurrentToolOfToolBar"); return; }
    __bar.sel = i; engine.trigger("SelectToolOfToolBar", i);
  },
  changeItem: function (slot, storageIdStr, storageSlot) {
    __bar.calls.push([typeof slot, typeof storageIdStr, typeof storageSlot]);
    var errs = [];
    if (typeof slot !== "number") errs.push("expected Number argument 0");
    if (typeof storageIdStr !== "string") errs.push("Wrong type - expected String, got " + typeof storageIdStr + " while converting argument 1 for changeItem");
    if (typeof storageSlot !== "number") errs.push("Wrong type - expected Number, got Undefined while converting argument 2 for changeItem");
    if (errs.length) throw new Error("An error occured while invoking function 'changeItem'. " + errs.join("; "));
    // As in Dual.exe: argument 2 is a storage id, argument 3 the item's slot in that storage.
    if (storageIdStr !== "0") { console.log("Cannot get storage: " + storageIdStr); return; }
    var typeId = __nanopack[storageSlot];
    if (!typeId) return; // nothing at that nanopack slot: the bar stays as it was
    // As in the 18:50 log: SetContentOfToolBar(target) a few ms later, then the tool's old slot
    // (if it was on the bar) is cleared: the bar holds one of each tool.
    setTimeout(function () {
      var old = -1;
      for (var j = 0; j < 9; j++) if (j !== slot && __bar.slots[j] === typeId) old = j;
      __setContent(slot, typeId);
      if (old >= 0) { __bar.slots[old] = ""; if (__bar.sel === old) __bar.sel = -1; engine.trigger("ClearContentOfToolBar", old); }
    }, __contentDelayMs);
  },
  checkItem: function () { return true; }, resetItem: function () { }, swapItems: function () { }
};
// Stock G as seen in game on 10-09: the first G puts the tool away, the second does nothing.
document.addEventListener("keydown", function (e) {
  if (e.keyCode !== 71 || __bar.sel < 0) return;
  setTimeout(function () { __bar.sel = -1; engine.trigger("ClearContentOfToolBar", -1); engine.trigger("DeselectCurrentToolOfToolBar"); }, 30);
}, false);
// The stock slot binding: after the HUD's keydown, select the slot if it holds something.
document.addEventListener("keydown", function (e) {
  var c = e.keyCode, slot = c >= 49 && c <= 57 ? c - 49 : -1;
  if (slot < 0) return;
  setTimeout(function () { if (__bar.slots[slot]) toolBar.selectItem(slot); }, 30);
}, false);
"""


def main():
    js = SCRIPT.read_text(encoding="utf-8")
    fails = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 3840, "height": 2160}, device_scale_factor=1)
        html = HERE / "_e2e_page.html"
        html.write_text(PAGE, encoding="utf-8")
        page.goto(html.as_uri())
        page.evaluate(STUBS)
        page.evaluate(BAR_STUB)
        # Toolbar state exists before the script loads (re-injection): the script never sees it.
        page.evaluate("""bar => { bar.forEach(function (id, i) { __bar.slots[i] = id; }); __bar.sel = 0; }""", BAR)
        cfg = {"hotkey": "4", "enableHotkey": True, "holdAlt": False, "showHudIcon": False, "hotkeyCode": 52,
               "defaultBar": "explore", "loadSlot": 8, "debug": True, "hideStockBar": False, "hideToolsInInventory": False,
               "quickKeys": [{"label": k, "code": c} for k, c in QUICK_KEYS]}
        src = compact(js).replace("__TOOLWHEEL_CONFIG__", json.dumps(cfg)).replace("__TOOLWHEEL_VERSION__", "e2e")
        page.evaluate("src => { (0, eval)(src); }", src)
        page.evaluate("np => { window.__nanopack = np; }", {str(t["slot"]): t["id"] for t in ROAM + BUILD_TOOLS})
        data = {"source": "nanopack", "tools": {"explore": ROAM, "build": BUILD_TOOLS},
                "bars": {"explore": [int(i) for i in BAR], "build": []}}
        page.evaluate("d => engine.trigger('ToolWheel.data', JSON.stringify(d))", data)

        n = len(ROAM)

        def wedge_xy(i, r=470):
            a = math.radians(-90 + i * 360 / n)
            return 1920 + r * math.cos(a), 1080 + r * math.sin(a)

        def mark():
            return page.evaluate("__logs.length")

        def since(m):
            return page.evaluate("m => __logs.slice(m)", m)

        def equipped():
            return page.evaluate("__bar.sel >= 0 ? __bar.slots[__bar.sel] : null")

        def check(name, cond, logs):
            print(("PASS " if cond else "FAIL ") + name)
            if not cond:
                fails.append(name)
                for line in logs:
                    print("      ", line[:240])

        def is_open():
            return page.evaluate("window.__toolWheel.open")

        # 1. Hotkey opens; LMB on a wedge whose tool is not on the bar loads it into the first
        #    empty slot (4, from the stored toolbar, not slot 1) and equips it.
        m = mark()
        page.keyboard.press("Digit4")
        page.wait_for_timeout(200)
        opened = is_open()
        page.mouse.move(*wedge_xy(3))
        page.mouse.down(); page.mouse.up()
        page.wait_for_timeout(1200)
        logs = since(m)
        check("1 hotkey opens, LMB on Mining loads it into slot 4 and equips it",
              opened and equipped() == ID["MiningTool"] and page.evaluate("__bar.slots[3]") == ID["MiningTool"]
              and page.evaluate("__bar.slots[0]") == ID["HarvestTool"]
              and any("mousedown button=0" in l for l in logs), logs)

        # 2. Quick-select with a stock conflict: key 2 = wedge 2 = Construct (bar slot 3), while
        #    the stock binding switches to slot 2 (Refuel). The wheel's choice must win.
        m = mark()
        page.keyboard.press("Digit4"); page.wait_for_timeout(200)
        page.keyboard.press("Digit2")
        page.wait_for_timeout(1500)
        logs = since(m)
        check("2 key 2 equips Construct over the stock slot-2 switch",
              not is_open() and equipped() == ID["BlueprintTool"]
              and any("quick-select key 2 -> BlueprintTool; stock switch overridden" in l for l in logs)
              and any("keydown keyCode=50 wheelOpen=true" in l for l in logs), logs)

        # 3. Hotkey 4 while open selects wedge 4 (Mining) instead of closing.
        m = mark()
        page.keyboard.press("Digit4"); page.wait_for_timeout(200)
        page.keyboard.press("Digit4")
        page.wait_for_timeout(1500)
        logs = since(m)
        check("3 hotkey 4 while open selects wedge 4", not is_open() and equipped() == ID["MiningTool"]
              and any("quick-select key 4" in l for l in logs), logs)

        # 4. '-' (keyCode 189) = wedge 11, Maneuver: loaded and equipped.
        m = mark()
        page.keyboard.press("Digit4"); page.wait_for_timeout(200)
        page.keyboard.press("Minus")
        page.wait_for_timeout(1500)
        logs = since(m)
        check("4 '-' equips Maneuver", equipped() == ID["ManeuverTool"]
              and any("keydown keyCode=189 wheelOpen=true" in l for l in logs), logs)

        # 5. Numpad 7 = wedge 7, Flatten.
        m = mark()
        page.keyboard.press("Digit4"); page.wait_for_timeout(200)
        # Headless Chromium sends Home (36) for Numpad7 without NumLock, so send keyCode 103 directly.
        page.evaluate("""() => ["keydown", "keyup"].forEach(function (t) {
            var e = new KeyboardEvent(t, { bubbles: true, cancelable: true });
            Object.defineProperty(e, "keyCode", { get: function () { return 103; } });
            document.dispatchEvent(e);
        })""")
        page.wait_for_timeout(1500)
        logs = since(m)
        check("5 numpad 7 equips Flatten", equipped() == ID["FlatteningTool"], logs)

        # 6. Hold the hotkey, aim, release: picks the aimed wedge (Harvest).
        m = mark()
        page.keyboard.down("Digit4"); page.wait_for_timeout(150)
        page.mouse.move(*wedge_xy(0)); page.wait_for_timeout(300)
        page.keyboard.up("Digit4")
        page.wait_for_timeout(1500)
        logs = since(m)
        check("6 hold, aim, release equips Harvest", not is_open() and equipped() == ID["HarvestTool"]
              and any("hotkey release" in l for l in logs), logs)

        # 7. '=' with 11 tools: no wedge, wheel stays open; Esc closes.
        m = mark()
        page.keyboard.press("Digit4"); page.wait_for_timeout(200)
        page.keyboard.press("Equal"); page.wait_for_timeout(100)
        still = is_open()
        page.keyboard.press("Escape"); page.wait_for_timeout(100)
        logs = since(m)
        check("7 '=' does nothing with 11 tools, Esc closes", still and not is_open()
              and any("keydown keyCode=187 wheelOpen=true" in l for l in logs), logs)

        # 8. Click outside the ring closes without equipping.
        page.wait_for_timeout(800)  # past step 7's slot-4 restore window
        m = mark()
        before = equipped()
        page.keyboard.press("Digit4"); page.wait_for_timeout(200)
        page.mouse.move(200, 200); page.mouse.down(); page.mouse.up()
        page.wait_for_timeout(500)
        logs = since(m)
        check("8 click outside closes", not is_open() and equipped() == before
              and any("closed (click outside)" in l for l in logs), logs)

        CLEAR = """id => { for (var i = 0; i < 9; i++) if (__bar.slots[i] === id) {
            __bar.slots[i] = ""; if (__bar.sel === i) __bar.sel = -1; engine.trigger("ClearContentOfToolBar", i); } }"""

        def data_of(explore):
            return {"source": "nanopack", "tools": {"explore": explore, "build": BUILD_TOOLS}, "bars": {"explore": [], "build": []}}

        # 9. Harvest is at nanopack slot 300 (hidden). Clear it off the bar, pick it: it loads from
        #    slot 300 with no special case and is selected.
        page.wait_for_timeout(800)
        page.evaluate(CLEAR, ID["HarvestTool"])
        m = mark()
        page.keyboard.press("Digit4"); page.wait_for_timeout(200)
        page.keyboard.press("Digit1")
        page.wait_for_timeout(1500)
        logs = since(m)
        check("9 Harvest loads from nanopack slot 300 and is selected", equipped() == ID["HarvestTool"]
              and any("LOAD HarvestTool bar" in l and "from nanopack slot 300: ok" in l for l in logs), logs)

        # 10. Stale slot: the wheel thinks Scanner is at its old slot, but it moved to 40. The load
        #     fails, the wheel re-asks the server ("refresh"), gets 40 and loads it.
        page.wait_for_timeout(800)
        scanner = next(t for t in ROAM if t["name"] == "ScannerTool")
        page.evaluate("""id => { for (var k in __nanopack) if (__nanopack[k] === id) delete __nanopack[k]; __nanopack[40] = id; }""", scanner["id"])
        page.evaluate(CLEAR, scanner["id"])
        page.evaluate("d => engine.trigger('ToolWheel.data', JSON.stringify(d))", data_of(ROAM))
        fresh = [dict(t, slot=40) if t["name"] == "ScannerTool" else dict(t) for t in ROAM]
        page.evaluate("d => { window.__refreshData = d; }", data_of(fresh))
        m = mark()
        page.keyboard.press("Digit4"); page.wait_for_timeout(200)
        page.keyboard.press("Digit" + str(ROAM.index(scanner) + 1))
        page.wait_for_timeout(3000)
        logs = since(m)
        check("10 stale slot: re-queried, loads Scanner from nanopack slot 40", equipped() == scanner["id"]
              and any("from nanopack slot %d: no SetContentOfToolBar" % scanner["slot"] in l for l in logs)
              and any("from nanopack slot 40: ok" in l for l in logs)
              and "refresh" in page.evaluate("__dataRequests"), logs)

        # 11. Unknown slot that the server cannot supply either: fails clearly after one re-query.
        page.wait_for_timeout(800)
        detector = next(t for t in ROAM if t["name"] == "DetectorTool")
        page.evaluate(CLEAR, detector["id"])
        d = data_of([dict(t, slot=None) if t["name"] == "DetectorTool" else dict(t) for t in fresh])
        page.evaluate("d => { engine.trigger('ToolWheel.data', JSON.stringify(d)); window.__refreshData = d; }", d)
        before = equipped()
        m = mark()
        page.keyboard.press("Digit4"); page.wait_for_timeout(200)
        page.keyboard.press("Digit" + str(ROAM.index(detector) + 1))
        page.wait_for_timeout(3000)
        logs = since(m)
        # (The stock slot-6 binding may toggle the equipped tool; only the Detector must not appear.)
        check("11 unknown slot fails clearly after one re-query", equipped() != detector["id"]
              and detector["id"] not in page.evaluate("__bar.slots")
              and any("LOAD DetectorTool bar" in l and "nanopack slot unknown; asking the server" in l for l in logs)
              and any("LOAD FAILED DetectorTool" in l for l in logs), logs)

        # 12. SetContentOfToolBar with the slot as a string (its arrival type in game is unconfirmed):
        #     the load is still recognised.
        page.wait_for_timeout(800)
        page.evaluate("() => { window.__slotAsString = true; window.__itemAsObject = true; }")
        page.evaluate("d => { engine.trigger('ToolWheel.data', JSON.stringify(d)); window.__refreshData = d; }", data_of(fresh))
        refuel = next(t for t in ROAM if t["name"] == "RefuelTool")
        page.evaluate(CLEAR, refuel["id"])
        m = mark()
        page.keyboard.press("Digit4"); page.wait_for_timeout(200)
        page.keyboard.press("Digit" + str(ROAM.index(refuel) + 1))
        page.wait_for_timeout(1500)
        logs = since(m)
        page.evaluate("() => { window.__slotAsString = false; window.__itemAsObject = false; }")
        check("12 load recognised with a string slot and an object item in SetContentOfToolBar", equipped() == refuel["id"]
              and any("LOAD RefuelTool bar" in l and ": ok" in l for l in logs), logs)

        # 13. G puts the tool away (stock); the second G does nothing in the stock bar, so the wheel
        #     re-equips the same tool.
        page.wait_for_timeout(800)
        m = mark()
        page.keyboard.press("KeyG"); page.wait_for_timeout(300)
        away = equipped()
        page.keyboard.press("KeyG"); page.wait_for_timeout(900)
        logs = since(m)
        check("13 second G re-equips the tool G put away", away is None and equipped() == refuel["id"]
              and any("G: putting away RefuelTool" in l for l in logs)
              and any("G: the game did nothing in 300 ms; re-equipping RefuelTool" in l for l in logs), logs)

        # 14. Trace: a stock-side changeItem (as a drag would make) is logged with types, by stock.
        m = mark()
        page.evaluate("() => toolBar.changeItem(7, '0', 20)")
        page.wait_for_timeout(100)
        logs = since(m)
        check("14 trace logs a stock changeItem with argument types", any(
            "[trace] toolBar.changeItem(7:number, \"0\":string, 20:number) by stock -> undefined:undefined" in l for l in logs), logs)

        calls = page.evaluate("__bar.calls")
        print("changeItem argument types seen:", sorted(set(tuple(c) for c in calls)))
        page.close()
        log_order_suite(browser, js, check)
        browser.close()
        html.unlink(missing_ok=True)
    print("ALL PASS" if not fails else "%d FAILED" % len(fails))
    sys.exit(1 if fails else 0)


# Live server, 10-09 18:50: real type ids where the log shows them, nanopack slots from Grains_dev.log.
LIVE = [("HarvestTool", "2687779164", 301), ("BlueprintTool", "1831253859", 10), ("RefuelTool", "1300972945", 18),
        ("MiningTool", "3206985070", 16), ("ScannerTool", "2865455409", 20), ("DetectorTool", "3543256774", 12),
        ("FlatteningTool", "9006", 13), ("PlanetSmoothTool", "3906188322", 17), ("DeployTool", "3999748458", 11),
        ("RepairTool", "778071808", 19), ("ManeuverTool", "9010", 15)]


def log_order_suite(browser, js, check):
    """Replays the 18:50 session: the script loads BEFORE the toolbar events (fresh client), the
    items arrive as JSON strings, the hotkey 4 also fires the stock slot-4 select, and a second
    copy of the script is injected on top of the first."""
    page = browser.new_page(viewport={"width": 3840, "height": 2160}, device_scale_factor=1)
    html = HERE / "_e2e_page2.html"
    html.write_text(PAGE, encoding="utf-8")
    page.goto(html.as_uri())
    page.evaluate(STUBS)
    page.evaluate(BAR_STUB)
    rows = {r[0]: dict(name=r[0], label=r[1], shortLabel=r[2], tooltip=r[3], icon=r[4]) for r in ROAMING}
    roam = []
    for name, tid, slot in LIVE:
        t = dict(rows[name])
        t["id"] = tid
        t["slot"] = slot
        roam.append(t)
    ID2 = {t["name"]: t["id"] for t in roam}

    def inject(version):
        cfg = {"hotkey": "4", "enableHotkey": True, "holdAlt": False, "showHudIcon": False, "hotkeyCode": 52,
               "defaultBar": "explore", "loadSlot": 8, "debug": True, "hideStockBar": False, "hideToolsInInventory": False,
               "quickKeys": [{"label": k, "code": c} for k, c in QUICK_KEYS]}
        src = compact(js).replace("__TOOLWHEEL_CONFIG__", json.dumps(cfg)).replace("__TOOLWHEEL_VERSION__", version)
        page.evaluate("src => { (0, eval)(src); }", src)

    def mark():
        return page.evaluate("__logs.length")

    def since(m):
        return page.evaluate("m => __logs.slice(m)", m)

    n = len(roam)

    def wedge_xy(i, r=470):
        a = math.radians(-90 + i * 360 / n)
        return 1920 + r * math.cos(a), 1080 + r * math.sin(a)

    def held():
        return page.evaluate("__bar.sel >= 0 ? __bar.slots[__bar.sel] : null")

    def pick(name):
        page.keyboard.press("Digit4")
        page.wait_for_timeout(200)
        page.mouse.move(*wedge_xy(next(i for i, t in enumerate(roam) if t["name"] == name)))
        page.mouse.down()
        page.mouse.up()

    # 15. Two instances: B takes over from A; then C takes over from B even though B's dispose throws.
    m = mark()
    inject("A")
    inject("B")
    page.evaluate("() => { window.__toolWheel.dispose = function () { throw new Error('sabotaged'); }; }")
    inject("C")
    logs = since(m)
    check("15 single instance: each new copy takes over and logs it",
          any("took over from A-" in l for l in logs) and any("instance C-" in l and "took over from B-" in l for l in logs)
          and page.evaluate("window.__toolWheel.version") == "C", logs)

    # The 18:50 event order: toolbar events AFTER the script loaded, items as JSON strings.
    page.evaluate("np => { window.__nanopack = np; }", {str(t["slot"]): t["id"] for t in roam})
    page.evaluate("""bar => {
        engine.trigger("HudManager.setContext", 1, false);
        engine.trigger("InitializeToolBar", 9);
        bar.forEach(function (id, i) { __setContent(i, id); });
        for (var i = bar.length; i < 9; i++) engine.trigger("ClearContentOfToolBar", i);
        engine.trigger("DeselectCurrentToolOfToolBar");
    }""", [ID2["HarvestTool"], ID2["BlueprintTool"], ID2["DeployTool"], "1413330661", ID2["RefuelTool"]])
    data = {"source": "nanopack", "tools": {"explore": roam, "build": []}, "bars": {"explore": [], "build": []}}
    page.evaluate("d => { engine.trigger('ToolWheel.data', JSON.stringify(d)); window.__refreshData = d; }", data)

    # 16. A tool already on the bar (Construct, slot 2) is selected in place, not reloaded into
    #     slot 1, and only one copy of the script answers the hotkey.
    m = mark()
    pick("BlueprintTool")
    page.wait_for_timeout(1000)
    logs = since(m)
    check("16 tool on the bar: selected in place, EQUIPPED, one instance answers",
          held() == ID2["BlueprintTool"] and page.evaluate("__bar.sel") == 1 and page.evaluate("__bar.calls.length") == 0
          and any("EQUIPPED BlueprintTool bar 1" in l for l in logs)
          and sum(1 for l in logs if l.startswith("[ToolWheel] opened (hotkey)")) == 1, logs)

    # 17. Repair is not on the bar: loaded into the first EMPTY slot (5), never bar 0; the load
    #     resolves on the event itself; then selectItem(5) and EQUIPPED.
    page.wait_for_timeout(800)
    m = mark()
    pick("RepairTool")
    page.wait_for_timeout(1500)
    logs = since(m)
    check("17 load into an empty slot, resolved on the event, then EQUIPPED",
          held() == ID2["RepairTool"] and page.evaluate("__bar.sel") == 5 and page.evaluate("__bar.slots[0]") == ID2["HarvestTool"]
          and any("LOAD RepairTool bar 5 from nanopack slot 19: ok (SetContentOfToolBar after" in l for l in logs)
          and any("EQUIPPED RepairTool bar 5 (loaded)" in l for l in logs)
          and not any("FAILED" in l for l in logs) and page.evaluate("__notes.length") == 0, logs)

    # 18. Timing: a bar that ignores a select for 40 ms after the slot's content changed is covered
    #     by the settle delay; one that ignores it for 150 ms is covered by the one retry.
    page.wait_for_timeout(800)
    page.evaluate("() => { __initDelayMs = 40; }")
    m = mark()
    pick("ScannerTool")
    page.wait_for_timeout(1500)
    logs40 = since(m)
    ok40 = held() == ID2["ScannerTool"] and any("EQUIPPED ScannerTool" in l and "retried" not in l for l in logs40)
    page.wait_for_timeout(800)
    page.evaluate("() => { __initDelayMs = 150; }")
    m = mark()
    pick("PlanetSmoothTool")
    page.wait_for_timeout(2000)
    logs150 = since(m)
    page.evaluate("() => { __initDelayMs = 0; }")
    check("18 select right after the load: settle delay covers 40 ms, retry covers 150 ms",
          ok40 and held() == ID2["PlanetSmoothTool"]
          and any("EQUIPPED PlanetSmoothTool" in l and "select retried" in l for l in logs150), logs40 + logs150)

    # 19. A select the bar never answers: one retry, then a clear EQUIP FAILED and a notification.
    page.wait_for_timeout(800)
    page.evaluate("() => { __dropSelects = 99; __notes = []; }")
    m = mark()
    pick("DetectorTool")
    page.wait_for_timeout(2500)
    logs = since(m)
    page.evaluate("() => { __dropSelects = 0; }")
    check("19 select never answered: retried once, then EQUIP FAILED",
          any("retrying once" in l for l in logs) and any("EQUIP FAILED DetectorTool" in l for l in logs)
          and page.evaluate("__notes.length") == 1 and not any("EQUIPPED DetectorTool" in l for l in logs), logs)

    # 20. The 18:50 sequence: the player re-opens the wheel with 4 while a load is in flight. The
    #     stock slot-4 select is left alone (no restore toggle), and the pick still ends with its
    #     own slot selected.
    page.wait_for_timeout(800)
    page.evaluate("() => { __contentDelayMs = 1000; }")
    m = mark()
    pick("FlatteningTool")
    page.evaluate("() => { __bar.selects = []; }")
    page.wait_for_timeout(700)      # past the open's own slot-key window, still inside the load
    page.keyboard.press("Digit4")  # re-open during the load: the stock binding selects slot 4 (index 3)
    page.wait_for_timeout(1500)
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    logs = since(m)
    selects = page.evaluate("__bar.selects")
    page.evaluate("() => { __contentDelayMs = 2; }")
    flat_slot = page.evaluate("id => __bar.slots.indexOf(id)", ID2["FlatteningTool"])
    check("20 hotkey during a load: no slot-4 restore toggle, the pick's own slot is selected last",
          held() == ID2["FlatteningTool"] and selects == [3, flat_slot]
          and any("left alone, a wheel pick is in flight" in l for l in logs)
          and any("EQUIPPED FlatteningTool bar %d" % flat_slot in l for l in logs), logs + ["selects " + str(selects)])

    # 21. Full bar, player holding the LoadSlot (9th): the load goes elsewhere, never the held slot.
    page.wait_for_timeout(800)
    page.evaluate("""ids => { ids.forEach(function (id, i) { __setContent(i, id); }); if (__bar.sel !== 8) toolBar.selectItem(8); }""",
                  [ID2[k] for k in ("HarvestTool", "BlueprintTool", "DeployTool", "RefuelTool", "RepairTool", "ScannerTool",
                                    "PlanetSmoothTool", "DetectorTool", "FlatteningTool")])
    page.wait_for_timeout(100)
    m = mark()
    pick("ManeuverTool")
    page.wait_for_timeout(1500)
    logs = since(m)
    check("21 full bar: never loads over the held slot", held() == ID2["ManeuverTool"]
          and page.evaluate("__bar.slots[8]") == ID2["FlatteningTool"]
          and any("LOAD ManeuverTool bar 7" in l for l in logs), logs)

    page.close()
    html.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
