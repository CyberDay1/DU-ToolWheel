"""Render the IMPLEMENTED wheel (src/client/toolwheel.js) the way the HUD would show it.

Loads the client script into headless Chromium at 3840x2160 over the mockup backdrop, with the
HUD globals (engine, toolBar, CPPMod, CPPHud, hudManager) stubbed and a stand-in #action_bar
whose text uses "Play" (the mockups' stand-in for the HUD sans, so the script's font routine has
a stock element to read). The script itself runs unmodified, compacted as the server sends it.

    python render_impl.py            # writes A_impl_roaming_v3.png, A_impl_build_v3.png and the A_impl_hotkey_* hub states

Icons come from the client install when present (resources_generated/iconsLib/misclib),
otherwise the tile shows no icon.
"""
import json
import pathlib
import sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / "src" / "client" / "toolwheel.js"
ICONS = pathlib.Path(r"C:\ProgramData\My Dual Universe\Game\data\resources_generated\iconsLib\misclib")

# Real item-bank display names and tooltips (local server, 10-09), in wheel order.
ROAMING = [
    ("HarvestTool", "Harvest Tool", "Harvest", "Gather surface minerals", "harvestool.png"),
    ("BlueprintTool", "Deploy construct", "Construct", "Blueprint construct deployment", "blueprintstool.png"),
    ("RefuelTool", "Refuel Tool", "Refuel", "Fuel Tank filling", "refueltool.png"),
    ("MiningTool", "Mine tool", "Mining", "Mine valuable ores", "miningtool.png"),
    ("ScannerTool", "Scanner", "Scanner", "Mid-range Ore Scanner", "scannertool.png"),
    ("DetectorTool", "Directional detector", "Detector", "Close range ore detector", "detectortool.png"),
    ("FlatteningTool", "Flatten tool", "Flatten", "Flatten Voxel surfaces", "flatteningtool.png"),
    ("PlanetSmoothTool", "Smooth Voxel tool", "Smooth", "Planet smoothen", "planetsmoothtool.png"),
    ("DeployTool", "Deploy ground Element", "Element", "Deploy ground Elements", "deploytool.png"),
    ("RepairTool", "Repair Tool", "Repair", "Fix damaged Elements", "repairtool.png"),
    ("ManeuverTool", "Maneuver Tool", "Maneuver", "Dynamic construct repositionning", "maneuvertool.png"),
]
BUILD = [
    ("ElementTool", "Deploy Element tool", "Element", "Deploy Elements on constructs", "elementtool.png"),
    ("VoxelTool", "Deploy Voxel tool", "Voxel", "Deploy Honeycomb Materials on constructs", "voxeltool.png"),
    ("LineTool", "Line Voxel tool", "Line", "Fills the space between two surfaces", "linetool.png"),
    ("AreaSmoothTool", "Area smooth Voxel tool", "Area smooth", "Smoothen construct Voxels in an area", "areasmoothtool.png"),
    ("SmoothTool", "Smooth Voxel tool", "Smooth", "Smoothen construct Voxels", "smoothtool.png"),
    ("LinkTool", "Link Elements tool", "Link", "Link functional Elements together", "linktool.png"),
    ("SelectTool", "Select Voxel tool", "Select", "Select and rearrange a Voxel selection.", "selecttool.png"),
    ("ReplaceTool", "Replace Voxel Tool", "Replace", "Select and replace Voxel material in a selection.", "replacetool.png"),
    ("MoveTool", "Move Element tool", "Move", "Move Elements on constructs", "movetool.png"),
    ("VertexTool", "Vertex precision tool", "Vertex", "Modify surfaces at the vertex level", "vertex_precision_tool.png"),
]
# Live server toolbar for player 10000: roaming holds 3 tools, build holds 9.
BAR_IDS = {"explore": [2687779164, 1831253859, 1300972945], "build": [823239531, 2798413040, 3533377567, 2799405554,
           2137208509, 1331685466, 128638317, 3499653616, 538966621]}

# Same as ToolWheelConfig.QuickKeys / QuickKeyCode defaults.
QUICK_KEYS = [(str(d), 48 + d) for d in range(1, 10)] + [("0", 48), ("-", 189), ("=", 187)]

CASES = [
    # name, mode, hovered wedge (-1 = mouse in the hub), selected stock slot, HUD event to fire after opening
    ("A_impl_roaming_v3", "explore", 9, 0, None),
    ("A_impl_build_v3", "build", 3, 0, None),
    ("A_impl_hotkey_hub", "explore", -1, 0, None),
    ("A_impl_hotkey_prompt", "explore", -1, 0, "ToolWheel.rebind"),
]


def tools(group):
    rows = ROAMING if group == "explore" else BUILD
    out = []
    for i, (name, label, short, tip, icon) in enumerate(rows):
        ids = BAR_IDS[group]
        out.append({"id": str(ids[i]) if i < len(ids) else str(9000 + i + (100 if group == "build" else 0)),
                    "name": name, "label": label, "shortLabel": short, "tooltip": tip, "icon": icon})
    return out


def compact(js):
    # Same as MyDuMod.BuildScript: trim, drop blank and whole-line comment lines.
    return "\n".join(l.strip() for l in js.split("\n") if l.strip() and not l.strip().startswith("//"))


PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Play:wght@400;700&display=block" rel="stylesheet">
<style>
 html, body { margin: 0; width: 3840px; height: 2160px; overflow: hidden; background: #000; }
 #bg { position: absolute; left: 0; top: 0; width: 3840px; height: 2160px; background: url(assets/backdrop.jpg) center / cover; }
 #action_bar { position: absolute; left: 1500px; top: 2000px; opacity: 0; font-family: "Play"; }
 #action_bar .item_body { display: inline-block; width: 90px; height: 90px; background-size: cover; }
</style></head><body><div id="bg"></div>
<div id="action_bar" class="enabled"><div class="active_container_name">Harvest Tool</div><div id="slots"></div></div>
</body></html>"""

STUBS = """
window.__logs = [];
var _h = {};
window.engine = {
  on: function (n, f) { (_h[n] = _h[n] || []).push(f); },
  trigger: function (n) { var a = Array.prototype.slice.call(arguments, 1); (_h[n] || []).forEach(function (f) { f.apply(null, a); }); },
  call: function () { }
};
window.toolBar = {
  selectItem: function (i) { engine.trigger("SelectToolOfToolBar", i); },
  changeItem: function () { }, checkItem: function () { return true; }, resetItem: function () { }, swapItems: function () { }
};
window.CPPMod = { sendModAction: function (m, id, a, p) { if (id === 102) __logs.push(p); } };
window.CPPHud = { toggleEnhancedMouse: function () { engine.trigger("HudManager.SetEnhancedMouse", true); },
  addFailureNotification: function () { } };
window.hudManager = { addNotificationIcon: function () { } };
window.NotificationIconComponent = function () { this.onClickEvent = { subscribe: function () { } }; this.HTMLNodes = { icon: {} }; };
var _log = console.log; console.log = function (s) { __logs.push(String(s)); _log.apply(console, arguments); };
"""


def main():
    js = SCRIPT.read_text(encoding="utf-8")
    icon_base = ICONS.as_uri() + "/" if ICONS.exists() else "missing://"
    if not ICONS.exists():
        print("client icon folder not found; icons will be blank", file=sys.stderr)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--allow-file-access-from-files"])
        page = browser.new_page(viewport={"width": 3840, "height": 2160}, device_scale_factor=1)
        for name, group, hover, selected, event in CASES:
            html = HERE / "_impl_page.html"
            html.write_text(PAGE, encoding="utf-8")
            page.goto(html.as_uri())
            page.wait_for_load_state("networkidle")
            page.evaluate("document.fonts.load('40px Play').then(function(){return document.fonts.ready})")
            # The stock bar shows the current mode's tools; the script must work the mode out from it.
            rows = tools(group)
            slots = "".join(
                '<div class="item_body" style="background-image:url(\'%s%s\')"></div>' % (icon_base, t["icon"])
                for t in rows[:len(BAR_IDS[group])])
            page.evaluate("s => { document.getElementById('slots').innerHTML = s; }", slots)
            page.evaluate(STUBS)
            cfg = {"hotkey": "4", "enableHotkey": True, "holdAlt": False, "showHudIcon": False, "hotkeyCode": 52,
                   "defaultBar": "explore", "loadSlot": 8, "debug": True,
                   "quickKeys": [{"label": k, "code": c} for k, c in QUICK_KEYS]}
            src = compact(js).replace("__TOOLWHEEL_CONFIG__", json.dumps(cfg)).replace("__TOOLWHEEL_VERSION__", "preview")
            page.evaluate("src => { (0, eval)(src); }", src)
            data = {"source": "nanopack", "tools": {"explore": tools("explore"), "build": tools("build")},
                    "bars": {k: [str(i) for i in v] for k, v in BAR_IDS.items()}}
            page.evaluate("""([d, ids, sel]) => {
                engine.trigger('ToolWheel.data', JSON.stringify(d));
                engine.trigger('InitializeToolBar', 9);
                ids.forEach(function (id, i) { engine.trigger('SetContentOfToolBar', i, { typeId: String(id) }); });
                engine.trigger('SelectToolOfToolBar', sel);
                engine.trigger('ToolWheel.show', 'preview');
            }""", [data, BAR_IDS[group], selected])
            page.wait_for_timeout(500)
            n = len(rows)
            import math
            if hover >= 0:
                a = math.radians(-90 + hover * 360 / n)
                page.mouse.move(1920 + 470 * math.cos(a), 1080 + 470 * math.sin(a))
            else:
                page.mouse.move(1920, 1080)
            if event:
                page.evaluate("e => engine.trigger(e, 'preview')", event)
            page.wait_for_timeout(300)
            page.screenshot(path=str(HERE / (name + ".png")))
            logs = page.evaluate("__logs")
            print("wrote", name + ".png")
            for l in logs:
                if any(w in l for w in ("font:", "mode:", "wheel drawn", "opened", "scale:")):
                    print("   ", l[:300])
        browser.close()
        (HERE / "_impl_page.html").unlink(missing_ok=True)


if __name__ == "__main__":
    main()
