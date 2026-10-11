# Tool Wheel (myDU server mod)

A radial tool wheel in the HUD. It shows every nanopack tool the player owns
(roaming tools on foot, build tools in build mode), not just the ones on the
stock toolbar; pick one and the game equips it. Each wedge has a fixed key
(1 to 0, then - and =), so a player can swap with two key presses. It replaces
the stock tool bar, which it hides (the consumable bar stays).

It is an embedded DLL mod (`ModToolWheel.dll`) for the myDU server's Orleans
service. The wheel itself is JavaScript that the server sends to each client
through the HUD's mod script event (`modinjectjs`). It touches nothing in the
client install, and nothing in licensing, authentication or online checks.

## Requirements (players)

- **Mod JS must be on in the client.** In `%LOCALAPPDATA%\NQ\myDU\settings.yaml`, set
  `game.enableModJS: true` (the setting is labelled "Enable MOD JS"). With it
  off, the client ignores the wheel script.

## Install (server admin)

1. Build it, or take a prebuilt `ModToolWheel.dll` (see *Build*).
2. Copy `ModToolWheel.dll` into the `Mods` folder at the root of your myDU server
   install. That folder is mounted into the `orleans` container as
   `/OrleansGrains/Mods`.
3. Optional: copy `ModToolWheel.json` next to it and edit it. Without it, the
   defaults below apply.
4. Restart `orleans` (`docker compose restart orleans`). No other service needs
   a restart: the mod adds no items.

Expected log lines in `logs/Grains_dev.log`:

```
INF MyDuMod] ToolWheel: initializing, config from /OrleansGrains/Mods/ModToolWheel.json
INF MyDuMod] ToolWheel: client script embedded, version <hash>, <n> bytes; hotkey 4 (keyCode 52, on), hold Alt off, debug off, tools nanopack, load slot 9, hide stock bar on, hide tools in inventory on, ..., quick keys 1 2 3 4 5 6 7 8 9 0 - =, 0 player(s) with their own hotkey
INF ModManagerGrain] Mod /OrleansGrains/Mods/ModToolWheel.dll initialized
```

When a player logs in:

```
INF MyDuMod] ToolWheel: injected wheel script v<hash> into player <id> (login, attempt 1 at +3s)
INF MyDuMod] ToolWheel: player <id> wheel script loaded: {"v":"<hash>",...}
```

The client drops scripts that arrive before its HUD is ready, so the server
re-sends the script on a schedule (`InjectDelaysSeconds`) until the script
reports back. If no "wheel script loaded" line appears, the server logs a
warning after the last attempt; the usual cause is `enableModJS` being off.

## Use (players)

- **Open:** press the hotkey (`4` by default), click the **TW** icon in the HUD
  notification icons (needs the mouse cursor), or right-click and choose
  **Tool Wheel > Open** (always works). With `HoldAlt` on, holding Alt also opens it.
- **Quick equip:** with the wheel open, press a wedge's key: the tool is
  equipped and the wheel closes. So `4` then `7` equips tool 7. The keys are
  `1 2 3 4 5 6 7 8 9 0 - =` in wedge order (clockwise from the top), shown as a
  key cap on each wedge; roaming uses 1 to 0 and `-` (11 tools), build uses 1 to
  0 (10 tools). A tool keeps its key as long as the wheel order stays the same.
  The numpad digits work too.
- **Pick with the mouse:** tap the hotkey, aim at a tool and left-click; or hold
  the hotkey (or Alt), aim, and release. The direction from the centre picks the
  wedge. The wheel turns the mouse cursor on while it is open and off again when
  it closes.
- **Close:** Escape, right-click, a click in the centre or outside the wheel.
- **The hotkey while the wheel is open.** `4` is both the hotkey and the key of
  wedge 4. While the wheel is open, `4` **selects wedge 4**; it no longer closes
  the wheel. Use Escape or a click outside to close without picking. If the
  hotkey is not a wedge key in the current mode (for example `-` in build mode,
  which has 10 tools), it still closes the wheel.
- **Tool Wheel > Reload** re-sends the script, for example after changing
  `ModToolWheel.json` or the script override.
- **Tool Wheel > Hide tools / Unhide tools** move the tools out of the
  inventory screen and back (see *Hiding tools in the nanopack*).
- **Change the hotkey:** open the wheel, move the mouse into the centre and
  click **Change** on the hub's last row (`HOTKEY [4] CHANGE`), then press the
  new key. Esc cancels; Backspace or the **Reset** button goes back to the
  server's default. The right-click menu has the same thing as **Tool Wheel >
  Set hotkey** (opens the wheel on the prompt) and **Tool Wheel > Reset
  hotkey**. The key is saved for you on the server and works at once, with no
  relog. See *Changing the hotkey*.

**The stock slot keys 1-9.** The digits are also DU's own "tool bar slot N"
keys, and the HUD cannot block the game's binding. With `SingleSlotBar` on (the
default) the stock bars hold one tool each, in `LoadSlot` (slot 9), and every
other slot is empty, so a stray digit hits an empty slot:
- **1-8 (wheel closed):** the game puts the tool away (an empty slot selects
  nothing), and the wheel takes it back out at once (`slot key <code>; restored
  slot 9` in the log).
- **9:** left to the game. It equips the tool in slot 9, or puts it away when it
  is already in hand, the same as G. G then takes it back out.
- **4 (the hotkey) and the quick keys:** as before, the wheel undoes the stock
  switch, and its own pick wins (any stock switch within about 700 ms of the key
  is undone).

The cleanest setup is still to remove the slot 1 to 9 bindings in DU's own
Controls settings: then the game does nothing on those keys and there is nothing
to undo. Custom bindings are saved in `%LOCALAPPDATA%\NQ\myDU\controls\`
(empty while the defaults are in use; the defaults ship inside the client). The
mod does not touch that folder.

The wheel lists the tools in the player's nanopack and follows the game's mode:
there is no mode switch in the wheel. Outside build mode it shows the roaming
tools (harvest, deploy construct, refuel, mine, scanner, detector, flatten,
smooth, deploy ground element, repair, maneuver); in build mode it shows the
build tools (element, voxel, line, area smooth, smooth, link, select, replace,
move, vertex). The wedge count follows the list. The key cap in a wedge's
corner is its quick-select key (the hub repeats it), and a short bar on the
inner edge marks the equipped tool. A
picked tool is put into `LoadSlot` (slot 9) and selected; the other slots are
cleared (`SingleSlotBar`, see *The single-slot bar*).

The look is design A (`mockups/A_true_radial.png`): a donut of wedges, a solid
bar outside the hovered wedge, and a centre hub with the mode, the tool's name,
description and bar slot. A dark backdrop covers the screen behind it so
nameplates do not show through. Sizes are the mockup's 4K pixel values scaled by
`window.innerHeight / 2160`. The font is copied from a stock text element (see
*Logs*), and the icons are the client's own (`resources_generated/iconsLib/misclib`).

## Configuration (`ModToolWheel.json`)

| Key | Default | Meaning |
|---|---|---|
| `Hotkey` | `4` | The server's default hotkey: one letter or digit, a JavaScript keyCode (`"220"` is `\`), or `"\\"`. The HUD reports keyCode only. A digit also triggers DU's stock slot key; the wheel undoes that switch (see *Setup tip*). A player who picks their own key in the wheel uses that instead (see *Changing the hotkey*). |
| `EnableHotkey` | `true` | `false` = open by icon or menu only, for everyone. It also hides the hub's **Change** row, and the server refuses hotkey changes. |
| `HoldAlt` | `false` | `true` = also open by holding Alt (150 ms, no other key), pick on release. Off by default because Alt is a modifier in stock combos. |
| `ShowHudIcon` | `true` | Add the TW icon to the HUD. |
| `DefaultBar` | `explore` | Group shown until the wheel has worked out the game's mode: `explore` (roaming) or `build`. |
| `ShowAllTools` | `false` | `true` = every enabled tool in the item bank, owned or not. |
| `LoadSlot` | `9` | The bar slot (1-9) the wheel loads tools into. With `SingleSlotBar` on, the only occupied slot of each tool bar. |
| `SingleSlotBar` | `true` | Keep each stock tool bar (roaming and build) empty except for `LoadSlot`, so the stock slot keys hit empty slots. `false` = the old behaviour: a tool goes to the first empty slot, else `LoadSlot`. |
| `HideStockBar` | `true` | Hide the stock tool bar (the consumable bar stays). See *Hiding the stock tool bar*. |
| `HideToolsInInventory` | `false` | Experimental. Hide the wheel's tools in the inventory window, client side only. Off because it flickers; see *Hiding tools in the inventory*. |
| `HideToolsInNanopack` | `true` | At login, and from **Tool Wheel > Hide tools**, move every tool below `HiddenSlotBase` up into the hidden range, which the inventory grid does not draw. See *Hiding tools in the nanopack*. |
| `HiddenSlotBase` | `1000` | First nanopack slot of the hidden range (1-32000; raised to the grid size if lower). |
| `QuickKeys` | `1 2 3 4 5 6 7 8 9 0 - =` | One key per wedge in wheel order (a JSON list of strings). Same forms as `Hotkey`, plus `"-"` and `"="`. A wedge past the end of the list has no key; `[]` turns quick-select off. |
| `InjectDelaysSeconds` | `3, 8, 15, 30, 60, 120, 240` | When the script is (re)sent after login, until the client confirms. |
| `ScriptOverridePath` | `/OrleansGrains/Mods/ToolWheel/toolwheel.js` | If this file exists, it replaces the built-in script. Edit it, then use **Tool Wheel > Reload**. |
| `Debug` | `false` | Log key events, toolbar events, probes and every load/select attempt, and turn on the binding trace (below). |
| `DebugForwardPerMinute` | `120` | Cap on client log lines copied into `Grains_dev.log` per player per minute. |

Admins also get **Tool Wheel > Toggle debug log** in the right-click menu.

## Logs and debugging

Every line the script writes starts with `[ToolWheel]`. Lines about behaviour
not yet confirmed in game also carry `[unproven]`.

- **Client:** `%LOCALAPPDATA%\NQ\myDU\log\log_<date>.xml`, newest file, as
  `ConsoleAPI ... [ToolWheel] ...` lines.
- **Server:** with debug on, the same lines are copied to `logs/Grains_dev.log`
  as `ToolWheel: [client <playerId>] ...`, plus one `data:` line per wheel
  open with the tool count, where the list came from, and the stored toolbar.

What to look for:

```
[ToolWheel] SELECT MiningTool slot 4: ok (SelectToolOfToolBar 3)
[ToolWheel] LOAD MiningTool bar 3 from nanopack slot 3: ok
[ToolWheel] LOAD ScannerTool bar 5: nanopack slot 4 looks stale (no SetContentOfToolBar); asking the server for its slot again
[ToolWheel] LOAD FAILED DetectorTool bar 5: nanopack slot unknown
[ToolWheel] live bar not seen since load; using the server's stored explore toolbar [...]
[ToolWheel] keydown keyCode=189 wheelOpen=true typing=false mouseMode=true
[ToolWheel] closed (quick-select key 7 (keyCode 55) -> FlatteningTool)
[ToolWheel] quick-select key 7 -> FlatteningTool; stock switch overridden (stock went to slot 7, wheel tool in slot 5)
[ToolWheel] mousedown button=0 at 1650,700 r=470 wedge=9 target=div#toolwheel_root
[ToolWheel] [unproven] cursor: toggleEnhancedMouse called, enhanced mouse is now true
[ToolWheel] hotkey keyCode 52 reaches the HUD
[ToolWheel] hotkey 52 opened wheel; restored slot 2 after the stock binding switched to slot 4, via toolBar.selectItem(1)
[ToolWheel] stock bar hidden via css display:none on div.<class> (from <n> tool_bar.css selector(s), <m> consumable_bar.css)
[ToolWheel] inventory: hid 11 tool entries via <list> <tile>
[ToolWheel] font: candidate "<family>" from hotbar name div.active_container_name: probe 186px vs missing-face 191px, loaded
[ToolWheel] [unproven] mode: build, from stock bar icons (0 roaming / 9 build tools on the stock bar; at open)
[ToolWheel] [unproven] wheel drawn with canvas 2d
[ToolWheel] [debug] scale: innerWidth ..., innerHeight ..., devicePixelRatio ..., k ...
[ToolWheel] G: putting away MiningTool (slot 4); the next G takes it back out
[ToolWheel] G: the game did nothing in 300 ms; re-equipping MiningTool from slot 4
```

**Binding trace (debug only).** With debug on, every call into `toolBar`, the
stock bar view `window.toolbar` and any `CPP*` inventory, storage, container,
item or toolbar binding is logged with its arguments, their types and the return
value; so is `engine.call` / `engine.trigger` traffic whose name looks tool- or
inventory-related, and the inventory tile a mouse press or drag starts on. The
wrappers pass every call through unchanged. Pressing I also lists each tool tile
in the inventory grid. The lines look like:

```
[ToolWheel] [trace] on: wrapped <n> function(s) [toolBar.changeItem ...]; CPP objects ...
[ToolWheel] [trace] toolBar.changeItem(2:number, "0":string, 20:number) by stock -> undefined:undefined
[ToolWheel] [trace] dom mousedown on inventory tile: list index 20 of 66; @class="item_slot ..."; icon scannertool.png; expandos ...
```

`by stock` is a call the game's own UI made; `by wheel` is one of the wheel's.
At most 20 lines per function per 10 s; the rest are counted.

**G (holster).** G puts the equipped tool away. In game the second G did not
take it back out (no toolbar event at all), so the wheel remembers the tool G
put away and re-selects it on the next G when the game has not re-equipped
anything within 300 ms.

## Build

Requirements: .NET SDK 6 or later.

1. Copy the NQ assemblies from the myDU mod toolkit's `ModAdmin` folder
   (`NQutils.dll`, `Backend.dll`, `Backend.PubSub.dll`, `Interfaces.dll`,
   `Router.Orleans.dll`) into `lib/`. They are not in this repository, because
   the toolkit licence does not allow redistributing them. You can point
   elsewhere with `-p:NQLibDir=<folder>/`.
2. `dotnet build -c Release`
3. The mod is `bin/Release/net6.0/ModToolWheel.dll`. The client script
   (`src/client/toolwheel.js`) is embedded in it.

Unit tests for the toolbar parsing, config and hiding plan need no NQ
assemblies: `dotnet test tests/`. `tests/client_single_slot_sim.js` runs the
client script against a model of the native tool bar (jsdom; `npm i jsdom`,
then `node tests/client_single_slot_sim.js src/client/toolwheel.js`): login,
picks, stray slot keys, 9, G, the `4` hotkey, quick keys and mode switches.
`tests/client_hotkey_sim.js` (same setup) drives a hotkey change: the hub's
Change button, a refused key, a digit (with the stock slot switch undone), the
old and new hotkeys, Esc, Backspace, the Reset and Cancel buttons and both menu
actions, against a stub server.

## How it works

- **Contents.** The server reads the player's nanopack (`IInventoryGrain.Get`)
  and keeps the items that are enabled `Tool`s in the item bank, split into
  `ExploreTool` (roaming) and `BuildTool` (build mode). Names and tooltips come
  from the item bank. The stock toolbar (`IPlayerGrain.GetToolbar`) holds only
  what the player dragged onto it. That is why the first version, which
  mirrored the toolbar, showed 3 of the 11 roaming tools.
- **Live bar.** The client sends the HUD `InitializeToolBar(n)`,
  `SetContentOfToolBar(slot, {typeId, ...})` and `ClearContentOfToolBar(slot)`.
  The wheel tracks these, so it knows which slot holds which tool and whether the
  live bar is the roaming bar or the build bar.
- **Selection.** `toolBar.selectItem(slot)`, 0-based. This is confirmed in game:
  the bar answers `SelectToolOfToolBar(slot)`.
- **Putting a tool on the bar.** `toolBar.changeItem(barIndex, "0", nanopackSlot)`,
  the stock drag-from-inventory handler: a 0-based bar index, the id of the
  storage the item comes from (`"0"` is the nanopack), and the item's slot in
  that storage. It does not take a type id (the old forms made the client log
  `Cannot get storage: <typeId>`). The server sends each tool's nanopack slot
  with the tool list, re-read from the inventory grain on every request (each
  wheel open), so a tool that moved, including one parked past the inventory
  grid, loads with no special case. If the slot is unknown, or the bar does not
  answer with `SetContentOfToolBar`, the wheel asks the server once more
  (unthrottled) and retries; then it fails with a notification. The bar index in
  `LOAD ... bar <n>` lines is 0-based, as passed to `changeItem`. The client
  saves the bar to the server itself.
- **Re-injected script.** A script that loads after the client sent its toolbar
  events has never seen the live bar. Until the next toolbar event, it uses the
  server's stored toolbar for the current mode, so a load goes into an empty
  slot and never over slot 1.

## Changing the hotkey

DU's own Controls menu cannot be extended from a mod (that would mean changing
the client), so the hotkey is changed inside the wheel. Each player has their own.

- **In the wheel:** the hub's last row reads `HOTKEY [<key>] CHANGE`. Click
  **Change** (with the mouse in the centre, the hub shows the tool in hand and
  this row). The hub turns into a prompt, *Press a key*, and the next key that
  reaches the HUD becomes the hotkey. Esc or **Cancel** (or any click) cancels
  the change and leaves the wheel open; Backspace or **Reset** goes back to the
  server's `Hotkey`. The answer shows in the hub for 4 seconds (*Hotkey set*,
  *Hotkey reset*, *Unchanged*, *Not saved*), and the row then shows the new key.
- **From the right-click menu:** **Tool Wheel > Set hotkey** opens the wheel on
  the prompt; **Tool Wheel > Reset hotkey** goes back to the default and opens
  the wheel to show it.
- **Saved per player, server side,** in `Mods/ToolWheel/player-hotkeys.json`
  (`{"<player id>": <keyCode>}`). A player with no entry uses `Hotkey`. The new
  key works at once: the server sends it to the running script
  (`ToolWheel.hotkey`), so nothing is re-sent and no relog or restart is needed.
  The script also gets it every time it loads.
- **Refused keys** (the prompt says why and waits for another key; the server
  checks again): Esc (cancels), Backspace (resets), Tab (cursor), Enter (chat),
  Shift / Ctrl / Alt, Caps / Num / Scroll Lock, the Windows and menu keys, Print
  Screen, G (the holster key the wheel already handles), and W A S D and Space
  (moving would open the wheel). A key that never reaches the HUD cannot be
  picked, because the prompt never sees it.
- **Keys that also do something else are allowed:** a quick key (`5`, say)
  keeps its wedge role while the wheel is open, so `5` opens the wheel and `5`
  again equips wedge 5; Esc closes it, as with the default `4`. A digit 1-9 is
  also DU's stock slot key; the wheel undoes that switch for whatever digit is
  the hotkey, and the old hotkey becomes an ordinary stray slot key (the
  single-slot guard puts the tool back). The result line mentions a quick-key
  overlap.

Server log lines:

```
INF MyDuMod] ToolWheel: player 10000 hotkey set to 5 (keyCode 53); it is also wedge 5's quick key: with the wheel open it equips that tool, so close with Esc; it is also the stock tool bar slot 5 key; the wheel undoes that switch
INF MyDuMod] ToolWheel: player 10000 hotkey W (keyCode 87) refused: a movement key would open the wheel while moving
INF MyDuMod] ToolWheel: player 10000 hotkey reset (menu) to the config default 4 (keyCode 52)
```

Client lines: `hotkey change: waiting for a key (hub button); now 4 (keyCode 52,
the server default)`, `hotkey change: asked the server for 5 (keyCode 53)`,
`hotkey now 5 (keyCode 53, saved for this player)`, `hotkey change cancelled
(Esc); still 4`.

## Hiding the stock tool bar

No class name is assumed. The script takes the leading class or id selector of
every rule in the HUD's own `action_bar/css/tool_bar.css`, looks those up inside
`#action_bar`, and keeps the outermost matches that hold nothing styled by
`consumable_bar.css`. It first tries `window.toolbar.visible = false` (the stock
view object has that boolean) and keeps it only if those elements then measure
as not shown and the consumable bar is unchanged; otherwise it sets
`display:none` on them. A MutationObserver on `#action_bar`, the toolbar events
and a 2 s check re-apply it when the HUD re-renders the bar. The bar still
exists and still gets its events, so `selectItem`, `changeItem` and mode
detection keep working. The log line `stock bar hidden via ...` names the
method and the elements; `stock bar NOT hidden` says why not.

## The single-slot bar

With `SingleSlotBar` on, each stock tool bar holds one tool, in `LoadSlot`:
- **A pick** clears every slot (`toolBar.resetItem(i)`), loads the tool into
  slot 9 (`toolBar.changeItem(8, "0", nanopackSlot)`) and selects it. A tool
  already in slot 9 is only selected, and any stray slots are cleared.
- **A bar seen with tools elsewhere** (login, the first switch to the build
  bar, a tool dragged onto the bar) is brought back to one slot about 400 ms
  after its events settle. The tool in hand, else the one in slot 9, else the
  first one, goes to slot 9, and the rest are cleared. It is equipped only if it
  was in hand. Log lines: `BAR normalise`, `CLEAR slot(s)`.
- Each bar keeps its tool, so the wheel's mode detection (which reads the tools
  on the bar) still sees the mode.

`toolBar.resetItem(barIndex)` is the clear call, from `Dual.exe` 1.4.18:
`ToolBarPanel::resetItem` (0x141460260) calls the tool bar container's slot
reset (0x140c99310). That reset unequips the slot if it is selected, writes an
empty item and notifies. On an empty slot it does nothing. The bar saves itself
to the server after a clear, as after `changeItem` ([unproven] until the stored
`player.toolbar` is seen with empty slots).

What a slot key does natively (container select, 0x140c9c0b0 / 0x140c997c0):
selecting the slot already selected selects nothing (the toggle), and selecting
an empty slot unequips the tool in hand and holds nothing.

## Hiding tools in the nanopack

**On by default.** The tools sit in nanopack slots the inventory grid does not
draw: the grid shows slots 0 to `nanopackMaxSlots` - 1 (256 on this server,
`Character.nanopackMaxSlots`). The server accepts any slot number, and the
client still holds the item, so `changeItem(bar, "0", slot)` loads it (10-09
test: HarvestTool at slot 300 vanished from the inventory and still equipped).
- **Range:** from `HiddenSlotBase` (1000) up. The server puts new items in the
  lowest free slot (`StorageWithSlotsV2.NewEmptySlot`), so nothing reaches 1000
  before 1000 lower slots are full. The grid cannot drop an item past 255
  either.
- **At login**, and from **Tool Wheel > Hide tools**: every tool below the base
  moves to the first free slot at or above it (`IDirectServiceGrain.StorageMove`,
  container 0). That covers new tools and starter tools the game grants again.
  With everything hidden it is a no-op. Log: `ToolWheel: player <id> hide tools
  (<why>): n/n moved, n confirmed in the nanopack [from->to ...]`; the moves are
  read back from the inventory before they count.
- **Tool Wheel > Unhide tools** moves them back to the first free visible slots
  and keeps that player's tools visible at later logins until **Hide tools** is
  used again. The choice is stored in `Mods/ToolWheel/unhidden-players.json`.
- The wheel re-reads the slots from the server on every open, and the server
  sends fresh slots after each hide or unhide.

## Hiding tools in the inventory (client side, off)

**Off by default (10-09).** Superseded by *Hiding tools in the nanopack*. In game it was buggy: the inventory grid
(`div#inventory ... div.itemSetView ... ul.items_slots_grid > li.item_slot`) is
virtualized and re-renders its entries while scrolling, so a hidden tool shows
again for a moment after every re-render, until the script hides it again. A
stylesheet rule would apply before paint, but none can reach the entry: the tool
is known only from the icon URL on `div.item_icon` deep inside the `li`, and
hiding the `li` from that needs `:has()`, which the HUD's engine lacks. A class
put on the `li` goes stale, because the grid reuses entries for other items. A
rule on the icon alone would leave an empty but live slot. So no flicker-free
route was found, and the option stays off. The code is unchanged; set it to
`true` only to experiment.

The tools stay in the nanopack (the wheel loads them onto the bar from there,
and the game may re-grant starter tools anyway); only their entries in the
inventory window are hidden. The inventory's DOM is not known yet, so a tile is
found from its icon: an image naming one of the wheel's tool icons, outside the
tool bar, whose nearest repeated list entry sits inside an element whose id or
class names an inventory (`inventor`, `nanopack`, `container`, `item_`). A
MutationObserver re-checks on every re-render. With debug on, each tool icon
found is logged with its ancestor chain, so the selectors can be pinned. If
pressing `I` finds no tool icon in the HUD view at all, the log says the
inventory is probably a separate view the script cannot reach, and nothing is
hidden.

## Known limits

- **Putting a tool on the bar**: `toolBar.changeItem(bar, "0", nanopackSlot)`.
  In the 10-09 18:23 and 18:50 logs every such call DID put the requested tool
  on the bar, but the wheel reported each one as failed. Root cause: the item in
  `SetContentOfToolBar(slot, item)` arrives as a JSON **string**, so
  `item.typeId` was undefined and every slot was recorded as empty. No tool was
  ever found on the bar, every load went to bar 0, and no load matched its
  event. The item is now parsed in whatever form it arrives. A pick also counts
  only once the tool is **equipped**: after the load, `selectItem(bar)` must be
  answered by `SelectToolOfToolBar(bar)` with that tool in the slot
  (`EQUIPPED <tool> bar <n>`). The select is retried once, then reported. Both
  steps resolve on the bar's own events; the timeouts are fallbacks only. While
  a pick is in flight, the slot-key restore and the G re-equip stand down.
  [unproven] Whether the stock bar needs a pause between `changeItem` and
  `selectItem`: the wheel waits 60 ms after the slot's content arrives, and the
  retry covers a longer wait.
- **Load target**: `LoadSlot`, alone (single-slot bar). With `SingleSlotBar`
  off: the first empty bar slot, else `LoadSlot`, and never the slot the player
  is holding.
- **One copy per HUD view**: a re-sent script of the same version is a no-op,
  and a different version disposes the old copy and logs
  `instance <new> took over from <old>`. Each handler also checks that its copy
  still owns `window.__toolWheel`, so a copy whose dispose failed goes inert.
  The 18:50 log has one copy only (one `loaded` line).
- **Mode detection is unproven.** No HUD flag for build mode is known. The wheel
  reads which group of tools the stock bar shows (its icons in `#action_bar`,
  then the toolbar events), since the game swaps the roaming and build bars with
  the mode. With an empty bar it keeps the last mode it saw, or `DefaultBar`.
  The `mode:` log line says which source decided.
- **Hotkey.** Digit keys do reach the HUD (an earlier note here said they did
  not; that was wrong). The game's own slot key fires too; see *Setup tip*.
- **Font.** The family is copied verbatim from a stock text element and checked
  by measuring a probe string against a face that cannot exist. If no candidate
  measures as loaded, the engine default is used and the log says so.
- **Cursor.** Turning the cursor on with `CPPHud.toggleEnhancedMouse` (what Tab
  does) is unproven. The cursor log line above settles it.
- **Inventory hiding is off**: it flickers. See *Hiding tools in the inventory*.
- No stock radial menu has been found to reuse. Debug mode scans globals, DOM
  classes and stylesheets for one and logs what it finds.
- If NQ renames HUD internals (`toolBar`, `#action_bar`, the toolbar events),
  the affected part stops working and the script logs it.

## Redesign (design A, implemented)

The user picked **A, true radial**, without the ROAMING / BUILD ring: the wheel
follows the game's mode instead of offering a toggle. The mockups stay in
`mockups/` for reference. `python mockups/render_impl.py` renders the real
client script (stubbed HUD, "Play" as the stand-in font) at 3840×2160 to
`mockups/A_impl_roaming_v3.png` and `mockups/A_impl_build_v3.png`.
`python mockups/e2e_impl.py` drives the same script through every equip path
(click, hold and release, quick keys including `-` and the numpad, the hotkey
while open, a stock slot switch to override, a re-injected script), against a
stub bar whose `changeItem(barIndex, storageIdStr, storageSlot)` resolves the
item from a stub nanopack, like the client, including a tool at nanopack slot
300, a stale slot and an unknown one.

The original mockup notes follow.

The v2 wheel works but looks unfinished: square tiles on a circle (several
overlap), a flat centre disc in a fallback serif font, tiny text at 4K, and no
hover or mode structure. Two directions are mocked up at 3840×2160 over an
in-game screenshot, in `mockups/`:

- **A, true radial** (`mockups/A_true_radial.png`): a donut of 11 wedges with
  the icon and a short label centred in each, a solid bar outside the hovered
  wedge, a centre hub with the mode, tool name, description and bar slot, and a
  two-arc ROAMING / BUILD ring between hub and wedges.
- **B, stock-native** (`mockups/B_stock_native.png`): context-menu rows (icon
  cell, uppercase label, shortcut `kbd`) fanned left and right of a small hub,
  with stock-style ROAMING / BUILD tabs above and a stock window panel below
  that holds the name, description and key hints.

Both use the stock visual language: sharp corners, thin cyan-white lines, dark
translucent panels, uppercase headers, no glow or gradients. The mockups use the
Play font as a stand-in for the HUD's sans. `python mockups/render.py`
re-renders them (headless Chromium).

The fix plan below is implemented as written, except: there is no mode ring,
and the hub is a little larger (radius 304 at 4K) to fill the space it left.


### Fix 1: the font

Symptom: the debug line says `font` was read from `#action_bar`, but the wheel
draws in the engine's default serif. The value read was never logged, so the
cause is not proven. The likely one: the stock HUD sets its font on the text
classes (in `dual.css` / `tool_bar.css`), not on `#action_bar`, so the
container's computed `fontFamily` is an inherited value that names no loaded
face. Coherent does not map generic names such as `sans-serif` to a real font
either, so the built-in fallback would fail the same way.

Fix:
- Read `getComputedStyle(n).fontFamily` from a stock element that holds visible
  text: candidates, in order, are a `.context_menu ul li a` entry, the hotbar's
  `.active_container_name`, then the first text-bearing node under
  `#action_bar`. Log the exact string and its source.
- Copy that string verbatim to `fontFamily` (no shorthand, no added fallback
  list).
- Confirm the face is loaded: measure the width of a probe span (`WMWMiiii`,
  40px) in the candidate family and in a family that cannot exist. Equal widths
  mean the family did not load: try the next candidate and log it.
- For design B, also give the rows the stock `.context_menu` markup and classes,
  so `dual.css` styles them (font included) directly.

### Fix 2: no overlapping hit areas

Selection is by angle and radius, not by per-tile DOM boxes. One `mousemove`
handler on the wheel root computes the angle from the centre and picks
`floor((angle + 90 + step / 2) / step) mod n`; inside the hub radius nothing is
picked. Each item owns exactly one sector, so no two can overlap at any count.
Design B uses the same angle test toward the nearest row, and its rows sit on a
fixed pitch larger than the row height.

Drawing: Coherent's SVG support is partial. Probe `canvas.getContext("2d")` and
draw the wedges on a canvas (arc + lineTo), with icons and labels as positioned
DOM nodes on top. Log which path is taken.

### Fix 3: sizes for a 4K screen

Every size in the mockups is in 4K device pixels. At load, log
`window.innerWidth`, `window.innerHeight` and `devicePixelRatio`, and scale every
mockup value by `k = window.innerHeight / 2160` (k = 0.5 if the HUD view is laid
out at 1080p and scaled up). Use px only: `vh` is double-scaled in DU's Coherent
views. Minimum text at 4K: labels 22-24px, body 30px, tool name 46-56px. A
backdrop dim (`rgba(3, 6, 9, 0.4)`, above HUD nameplates) keeps world labels from
showing through the wheel.

### Fix 4: the hotkey

Superseded: the 10-09 log shows `keydown 52` reaching the HUD, so digits do
reach it and the default is back to `4` (see *Setup tip*). The original note
follows.

Digit keys never reach the HUD. Across every test log, the HUD received only:
Ctrl (17), Alt (18), F (70), Tab (9), Backspace (8), Escape (27), backslash
`\` (220), and Print Screen (44). F, Tab, Escape and Ctrl already do things in
game, and Print Screen takes screenshots.

Proposal:
- Default `Hotkey` becomes `"220"` (`\`): it reaches the HUD and has no stock
  action. On non-US layouts the physical key differs, so the config stays
  editable.
- Opt-in `"18"` (hold Alt): open on Alt held for more than 150 ms with no other
  key pressed, pick on release. Off by default because Alt is a modifier in
  stock combos.
- The right-click **Tool Wheel > Open** entry (stock context-menu mechanism)
  stays as the always-working route. A stock key binding for mod actions has not
  been found.
