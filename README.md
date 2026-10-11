# Tool Wheel

A myDU server mod: a radial tool wheel in the HUD. It shows every nanopack tool
the player owns (roaming tools on foot, build tools in build mode), not just the
ones on the stock tool bar, and replaces that bar.

- Open it with a hotkey (`4` by default) or the HUD icon.
- Pick with the mouse, or press a wedge's key (1 to 0, then - and =) for a
  two-key swap.
- Change the hotkey from inside the wheel; it's saved per player.

It touches nothing in the client install: the wheel is JavaScript the server
sends to each client.

## Install

1. Build it (see `GUIDE.md`) and copy `ModToolWheel.dll` into the server's
   `Mods` folder.
2. Optional: copy `ModToolWheel.json` next to it to change the defaults.
3. Restart the `orleans` service.

Players need **Enable MOD JS** on in the client (`game.enableModJS: true`).

The NQ toolkit assemblies are not included (toolkit licence); copy them into
`lib/` before building.

## More

`GUIDE.md` covers use, configuration, logs, building, how it works and known
limits.

## Licence

MIT, see `LICENSE`. The NQ toolkit assemblies the build needs are not covered
and not included.
