using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Backend;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using NQ;
using NQ.Interfaces;
using NQutils;
using Orleans;
using ToolWheel;

/// Entry point. The Orleans host looks for a class named MyDuMod implementing IMod
/// in every Mods/Mod*.dll.
///
/// The mod injects a radial tool wheel into each client's HUD through the sanctioned
/// "modinjectjs" HUD event (players need game.enableModJS on). The wheel lists every
/// nanopack tool the player owns (read server-side from the inventory grain) and selects
/// it through the client's own toolBar model. Nothing here touches licensing,
/// authentication or online checks.
public class MyDuMod : IMod
{
    public const string ModName = "ToolWheel";

    // Right-click menu actions (ModActionContext.Global).
    private const ulong ActionOpen = 1;
    private const ulong ActionReload = 2;
    private const ulong ActionDebugToggle = 3;
    private const ulong ActionHideTools = 4;
    private const ulong ActionUnhideTools = 5;
    private const ulong ActionSetHotkey = 6;
    private const ulong ActionResetHotkey = 7;
    // Actions sent by the injected script with CPPMod.sendModAction.
    private const ulong ActionHello = 100;
    private const ulong ActionRequestData = 101;
    private const ulong ActionClientLog = 102;
    private const ulong ActionHotkeyRequest = 103;

    private IServiceProvider isp;
    private IClusterClient orleans;
    private ILogger logger;
    private IGameplayBank bank;
    private IPub pub;
    private ToolWheelConfig cfg = new();
    private string embeddedScript;
    private readonly ConcurrentDictionary<ulong, PlayerState> players = new();
    // Players who chose Unhide tools: the login routine leaves their tools visible until they
    // choose Hide tools again. Kept in a file so the choice survives an orleans restart.
    private readonly HashSet<ulong> unhidden = new();
    private string unhiddenPath;
    // Hotkeys players chose in the wheel (keyCode per player id); the config Hotkey otherwise.
    private readonly Dictionary<ulong, int> hotkeys = new();
    private string hotkeysPath;

    private sealed class PlayerState
    {
        public CancellationTokenSource InjectCts;
        public volatile bool Confirmed;
        public DateTime LastData = DateTime.MinValue;
        public DateTime LogWindowStart = DateTime.MinValue;
        public int LogCount;
        public readonly object Lock = new();
        public readonly SemaphoreSlim HideLock = new(1, 1);
    }

    public string GetName() => ModName;

    public Task Initialize(IServiceProvider isp)
    {
        this.isp = isp;
        orleans = isp.GetRequiredService<IClusterClient>();
        logger = isp.GetRequiredService<ILogger<MyDuMod>>();
        bank = isp.GetRequiredService<IGameplayBank>();
        pub = isp.GetRequiredService<IPub>();

        string source;
        try
        {
            (cfg, source) = ToolWheelConfig.Load(ToolWheelConfig.DefaultPath);
        }
        catch (Exception e)
        {
            logger.LogError(e, "ToolWheel: config unreadable, using defaults");
            cfg = new ToolWheelConfig();
            source = "defaults (config unreadable)";
        }
        logger.LogInformation("ToolWheel: initializing, config from {source}", source);
        unhiddenPath = Path.Combine(Path.GetDirectoryName(ToolWheelConfig.DefaultPath) ?? ".", "ToolWheel", "unhidden-players.json");
        LoadUnhidden();
        hotkeysPath = Path.Combine(Path.GetDirectoryName(ToolWheelConfig.DefaultPath) ?? ".", "ToolWheel", "player-hotkeys.json");
        LoadHotkeys();

        using (var s = typeof(MyDuMod).Assembly.GetManifestResourceStream("ToolWheel.toolwheel.js"))
        using (var r = new StreamReader(s))
            embeddedScript = r.ReadToEnd();

        var (script, version, origin) = BuildScript();
        logger.LogInformation(
            "ToolWheel: client script {origin}, version {version}, {bytes} bytes; hotkey {hotkey} (keyCode {code}, {hk}), hold Alt {alt}, debug {debug}, tools {tools}, load slot {slot}, single-slot bar {single}, hide stock bar {hide}, hide tools in inventory {inv}, hide tools in nanopack {nano} (from slot {base}, {opt} player(s) opted out), quick keys {quick}, {own} player(s) with their own hotkey",
            origin, version, script.Length, cfg.Hotkey, ToolWheelConfig.HotkeyCode(cfg.Hotkey), cfg.EnableHotkey ? "on" : "off", cfg.HoldAlt ? "on" : "off",
            cfg.Debug ? "on" : "off", cfg.ShowAllTools ? "all enabled" : "nanopack", cfg.LoadSlot, cfg.SingleSlotBar ? "on" : "off", cfg.HideStockBar ? "on" : "off", cfg.HideToolsInInventory ? "on" : "off",
            cfg.HideToolsInNanopack ? "on" : "off", NanopackHiding.EffectiveBase(cfg.HiddenSlotBase, GridSize()), unhidden.Count,
            cfg.QuickKeys.Count > 0 ? string.Join(" ", cfg.QuickKeys) : "off", HotkeyCount());
        foreach (var k in cfg.QuickKeys.Where(k => ToolWheelConfig.QuickKeyCode(k) == 0))
            logger.LogWarning("ToolWheel: quick key {key} is not one letter, digit, '-', '=' or keyCode; its wedge has no key", k);
        if (cfg.EnableHotkey && ToolWheelConfig.HotkeyCode(cfg.Hotkey) == 0)
            logger.LogWarning("ToolWheel: Hotkey {hotkey} is not one letter, digit or keyCode; the hotkey is off", cfg.Hotkey);
        return Task.CompletedTask;
    }

    /// Returns the client script with config and version baked in.
    private (string script, string version, string origin) BuildScript()
    {
        string body = embeddedScript, origin = "embedded";
        try
        {
            if (!string.IsNullOrEmpty(cfg.ScriptOverridePath) && File.Exists(cfg.ScriptOverridePath))
            {
                body = File.ReadAllText(cfg.ScriptOverridePath);
                origin = "override " + cfg.ScriptOverridePath;
            }
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "ToolWheel: script override unreadable, using embedded script");
        }
        var clientCfg = cfg.ClientJson();
        string version;
        using (var sha = SHA1.Create())
            version = Convert.ToHexString(sha.ComputeHash(Encoding.UTF8.GetBytes(body + clientCfg)))[..10].ToLowerInvariant();
        // Drop whole-line comments and indentation: the script travels to every client on login.
        var compact = string.Join("\n", body.Split('\n')
            .Select(l => l.Trim())
            .Where(l => l.Length > 0 && !l.StartsWith("//")));
        var script = compact
            .Replace("__TOOLWHEEL_CONFIG__", clientCfg)
            .Replace("__TOOLWHEEL_VERSION__", version);
        return (script, version, origin);
    }

    public Task<ModInfo> GetModInfoFor(ulong playerId, bool isPlayerAdmin)
    {
        // A client asks for mod info when it connects. Its HUD is usually not ready yet and
        // drops "modinjectjs" until it is, so the script is re-sent on a schedule until the
        // script itself reports back (ActionHello).
        StartInjection(playerId, "login");
        // Tools in a visible slot (new ones, or defaults the game granted again) go back into the
        // hidden range. A no-op when they are all hidden already.
        if (cfg.HideToolsInNanopack && !IsUnhidden(playerId))
            _ = Task.Run(() => HideTools(playerId, "login"));

        var info = new ModInfo
        {
            name = ModName,
            actions = new List<ModActionDefinition>
            {
                new ModActionDefinition { id = ActionOpen, label = "Tool Wheel\\Open", context = ModActionContext.Global },
                new ModActionDefinition { id = ActionReload, label = "Tool Wheel\\Reload", context = ModActionContext.Global },
                new ModActionDefinition { id = ActionHideTools, label = "Tool Wheel\\Hide tools", context = ModActionContext.Global },
                new ModActionDefinition { id = ActionUnhideTools, label = "Tool Wheel\\Unhide tools", context = ModActionContext.Global },
                new ModActionDefinition { id = ActionSetHotkey, label = "Tool Wheel\\Set hotkey", context = ModActionContext.Global },
                new ModActionDefinition { id = ActionResetHotkey, label = "Tool Wheel\\Reset hotkey", context = ModActionContext.Global },
            },
        };
        if (isPlayerAdmin)
            info.actions.Add(new ModActionDefinition { id = ActionDebugToggle, label = "Tool Wheel\\Toggle debug log", context = ModActionContext.Global });
        return Task.FromResult(info);
    }

    private void StartInjection(ulong playerId, string why)
    {
        var st = players.GetOrAdd(playerId, _ => new PlayerState());
        CancellationTokenSource cts;
        lock (st.Lock)
        {
            st.InjectCts?.Cancel();
            st.InjectCts = cts = new CancellationTokenSource();
            st.Confirmed = false;
        }
        _ = Task.Run(async () =>
        {
            int attempt = 0;
            double elapsed = 0;
            foreach (var at in cfg.InjectDelaysSeconds.OrderBy(d => d))
            {
                try { await Task.Delay(TimeSpan.FromSeconds(Math.Max(0, at - elapsed)), cts.Token); }
                catch (TaskCanceledException) { return; }
                elapsed = at;
                if (st.Confirmed || cts.IsCancellationRequested)
                    return;
                attempt++;
                await Inject(playerId, $"{why}, attempt {attempt} at +{at:0}s");
            }
            if (!st.Confirmed && !cts.IsCancellationRequested)
                logger.LogWarning(
                    "ToolWheel: player {player} never confirmed the wheel script after {n} attempts. " +
                    "Likely causes: game.enableModJS is off on that client, or the HUD rejected the script (see the client log, ConsoleAPI lines)",
                    playerId, attempt);
        });
    }

    private async Task Inject(ulong playerId, string why)
    {
        try
        {
            var (script, version, _) = BuildScript();
            await SendHudEvent(playerId, "modinjectjs", script);
            logger.LogInformation("ToolWheel: injected wheel script v{version} into player {player} ({why})", version, playerId, why);
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "ToolWheel: injection into player {player} failed", playerId);
        }
    }

    private Task SendHudEvent(ulong playerId, string eventName, string payload) =>
        pub.NotifyTopic(Topics.PlayerNotifications(playerId),
            new NQutils.Messages.ModTriggerHudEventRequest(new ModTriggerHudEvent
            {
                eventName = eventName,
                eventPayload = payload,
            }));

    public async Task TriggerAction(ulong playerId, ModAction action)
    {
        try
        {
            switch (action.actionId)
            {
                case ActionOpen:
                    if (!players.TryGetValue(playerId, out var st0) || !st0.Confirmed)
                        await Inject(playerId, "open requested before script confirmed");
                    await SendData(playerId, force: true);
                    await SendHudEvent(playerId, "ToolWheel.show", "menu");
                    break;
                case ActionReload:
                    StartInjection(playerId, "reload requested");
                    await Inject(playerId, "reload requested");
                    break;
                case ActionDebugToggle:
                    if (!await orleans.GetPlayerGrain(playerId).IsAdmin())
                        return;
                    await SendHudEvent(playerId, "ToolWheel.debug", "toggle");
                    break;
                case ActionHideTools:
                    SetUnhidden(playerId, false);
                    await HideTools(playerId, "menu");
                    break;
                case ActionUnhideTools:
                    SetUnhidden(playerId, true);
                    await UnhideTools(playerId, "menu");
                    break;
                case ActionSetHotkey:
                    if (!players.TryGetValue(playerId, out var st1) || !st1.Confirmed)
                        await Inject(playerId, "set hotkey requested before script confirmed");
                    await SendHotkey(playerId, "info");
                    await SendData(playerId, force: true);
                    await SendHudEvent(playerId, "ToolWheel.rebind", "menu");
                    break;
                case ActionResetHotkey:
                    await ResetHotkey(playerId, "menu");
                    break;
                case ActionHotkeyRequest:
                    await OnHotkeyRequest(playerId, action.payload);
                    break;
                case ActionHello:
                    OnHello(playerId, action.payload);
                    await SendHotkey(playerId, "info");
                    await SendData(playerId, force: true);
                    break;
                case ActionRequestData:
                    // "refresh": the client found a tool's slot unknown or stale and must not be throttled.
                    await SendData(playerId, force: action.payload == "refresh");
                    break;
                case ActionClientLog:
                    OnClientLog(playerId, action.payload);
                    break;
            }
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "ToolWheel: action {action} from player {player} failed", action.actionId, playerId);
        }
    }

    private void OnHello(ulong playerId, string payload)
    {
        var st = players.GetOrAdd(playerId, _ => new PlayerState());
        st.Confirmed = true;
        lock (st.Lock)
            st.InjectCts?.Cancel();
        logger.LogInformation("ToolWheel: player {player} wheel script loaded: {payload}", playerId, Truncate(payload, 600));
    }

    private void OnClientLog(ulong playerId, string payload)
    {
        var st = players.GetOrAdd(playerId, _ => new PlayerState());
        lock (st.Lock)
        {
            var now = DateTime.UtcNow;
            if (now - st.LogWindowStart > TimeSpan.FromMinutes(1))
            {
                st.LogWindowStart = now;
                st.LogCount = 0;
            }
            if (++st.LogCount > cfg.DebugForwardPerMinute)
                return;
        }
        logger.LogInformation("ToolWheel: [client {player}] {line}", playerId, Truncate(payload, 2000));
    }

    /// Sends the wheel its contents: every nanopack tool the player owns, split into roaming
    /// (ExploreTool) and build (BuildTool) tools, plus the stock toolbar layout so the client
    /// knows which tools already sit in a slot.
    private async Task SendData(ulong playerId, bool force)
    {
        var st = players.GetOrAdd(playerId, _ => new PlayerState());
        lock (st.Lock)
        {
            if (!force && DateTime.UtcNow - st.LastData < TimeSpan.FromMilliseconds(500))
                return;
            st.LastData = DateTime.UtcNow;
        }

        // Stock toolbar (slot -> type id). Used only to show slot numbers and to pick a slot
        // the client can load a tool into; the client tracks the live bar from engine events.
        Dictionary<string, List<ulong>> bars = new();
        string barNote = "ok";
        try
        {
            var tb = await orleans.GetPlayerGrain(playerId).GetToolbar();
            bars = ToolbarLayout.Parse(tb?.content);
        }
        catch (Exception e)
        {
            barNote = "GetToolbar failed: " + e.Message;
        }

        // Owned tools, from the player's nanopack. Tools are ordinary items there
        // (newPlayerDefaultQty 1); the toolbar holds only the ones dragged onto it.
        var tools = new List<ToolCatalog.Entry>();
        string source = cfg.ShowAllTools ? "item bank (ShowAllTools)" : "nanopack";
        if (!cfg.ShowAllTools)
        {
            try
            {
                var inv = await orleans.GetInventoryGrain(playerId).Get(playerId);
                // The slot travels with the tool: the client loads it with
                // toolBar.changeItem(bar, "0", slot). It can move (inventory edits, hiding), so it
                // is re-read on every request rather than cached.
                foreach (var slot in inv.content)
                {
                    var e = ToolEntry(slot.content.type);
                    if (e == null) continue;
                    e.Slot = (int)slot.position;
                    tools.Add(e);
                }
                if (tools.Count == 0)
                    source = "item bank (nanopack holds no tools)";
            }
            catch (Exception e)
            {
                source = "item bank (nanopack unreadable: " + e.Message + ")";
            }
        }
        if (tools.Count == 0)
        {
            foreach (var name in ToolCatalog.ExploreOrder.Concat(ToolCatalog.BuildOrder))
            {
                var def = bank.GetDefinition(name);
                var e = def == null ? null : ToolEntry(def.Id);
                if (e != null) tools.Add(e);
            }
        }

        var payload = new
        {
            source,
            iconFiles = true,
            tools = new Dictionary<string, object>
            {
                ["explore"] = ToolCatalog.Order(tools, "explore").Select(ToolCatalog.ClientDto).ToList(),
                ["build"] = ToolCatalog.Order(tools, "build").Select(ToolCatalog.ClientDto).ToList(),
            },
            bars = new Dictionary<string, object>
            {
                ["explore"] = bars.GetValueOrDefault("explore") ?? new List<ulong>(),
                ["build"] = bars.GetValueOrDefault("build") ?? new List<ulong>(),
            },
        };
        if (cfg.Debug)
            logger.LogInformation(
                "ToolWheel: player {player} data: {n} tool(s) from {source}; nanopack slots [{slots}]; server toolbar {note} explore=[{explore}] build=[{build}]",
                playerId, tools.Count, source,
                string.Join(" ", tools.Select(t => t.Name + "@" + (t.Slot >= 0 ? t.Slot.ToString() : "?"))), barNote,
                string.Join(",", bars.GetValueOrDefault("explore") ?? new List<ulong>()),
                string.Join(",", bars.GetValueOrDefault("build") ?? new List<ulong>()));
        await SendHudEvent(playerId, "ToolWheel.data", JsonSerializer.Serialize(payload));
    }

    // ---------------------------------------------------------------- hiding tools in the nanopack
    /// Visible nanopack grid size: Character.nanopackMaxSlots in the item bank, or 64 (the stock
    /// default) when unreadable.
    private int GridSize()
    {
        try
        {
            var def = bank.GetDefinition("Character");
            var c = def == null ? null : bank.GetBaseObject<NQutils.Def.Character>(def.Id);
            if (c != null && c.NanopackMaxSlots > 0)
                return c.NanopackMaxSlots;
        }
        catch (Exception e)
        {
            logger.LogDebug(e, "ToolWheel: Character.nanopackMaxSlots unreadable");
        }
        return 64;
    }

    private bool IsTool(ulong typeId)
    {
        try
        {
            var def = bank.GetDefinition(typeId);
            return def != null && def.Is<NQutils.Def.Tool>();
        }
        catch
        {
            return false;
        }
    }

    private async Task<List<NanopackHiding.Item>> NanopackItems(ulong playerId)
    {
        var inv = await orleans.GetInventoryGrain(playerId).Get(playerId);
        return inv.content
            .Select(s => new NanopackHiding.Item((int)s.position, IsTool(s.content.type)))
            .ToList();
    }

    /// Moves every tool sitting below the hidden base into the hidden range.
    private Task HideTools(ulong playerId, string why) =>
        RunMoves(playerId, why, "hide", items => NanopackHiding.PlanHide(items, NanopackHiding.EffectiveBase(cfg.HiddenSlotBase, GridSize())));

    /// Moves every hidden tool back into the first free visible slots.
    private Task UnhideTools(ulong playerId, string why) =>
        RunMoves(playerId, why, "unhide", items => NanopackHiding.PlanUnhide(items, GridSize()));

    private async Task RunMoves(ulong playerId, string why, string what, Func<List<NanopackHiding.Item>, List<NanopackHiding.Move>> plan)
    {
        var st = players.GetOrAdd(playerId, _ => new PlayerState());
        await st.HideLock.WaitAsync();
        try
        {
            var items = await NanopackItems(playerId);
            var moves = plan(items);
            int tools = items.Count(i => i.IsTool);
            if (moves.Count == 0)
            {
                logger.LogInformation("ToolWheel: player {player} {what} tools ({why}): nothing to move ({tools} tool(s) in the nanopack)", playerId, what, why, tools);
                return;
            }
            var ds = orleans.GetDirectServiceGrain();
            int ok = 0;
            var failed = new List<string>();
            foreach (var m in moves)
            {
                try
                {
                    await ds.StorageMove(playerId, new StorageMove { fromContainer = 0, fromSlot = m.From, toContainer = 0, toSlot = m.To, quantity = 1 });
                    ok++;
                }
                catch (Exception e)
                {
                    failed.Add(m + " (" + e.Message + ")");
                }
            }
            // Read back: a move counts once the inventory shows a tool in its target slot.
            var after = await NanopackItems(playerId);
            var bySlot = after.GroupBy(i => i.Slot).ToDictionary(g => g.Key, g => g.First());
            int confirmed = moves.Count(m => bySlot.TryGetValue(m.To, out var i) && i.IsTool);
            logger.LogInformation(
                "ToolWheel: player {player} {what} tools ({why}): {ok}/{n} moved, {confirmed} confirmed in the nanopack [{moves}]{failed}",
                playerId, what, why, ok, moves.Count, confirmed, string.Join(" ", moves),
                failed.Count > 0 ? "; FAILED " + string.Join(", ", failed) : "");
            int stillHidden = after.Count(i => i.IsTool && i.Slot >= GridSize());
            if (what == "unhide" && stillHidden > 0)
                logger.LogWarning("ToolWheel: player {player} unhide: the visible grid is full, {n} tool(s) stay hidden", playerId, stillHidden);
            // The wheel loads by slot: send it the new ones.
            if (players.TryGetValue(playerId, out var ps) && ps.Confirmed)
                await SendData(playerId, force: true);
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "ToolWheel: player {player} {what} tools ({why}) failed", playerId, what, why);
        }
        finally
        {
            st.HideLock.Release();
        }
    }

    private bool IsUnhidden(ulong playerId)
    {
        lock (unhidden) return unhidden.Contains(playerId);
    }

    private void SetUnhidden(ulong playerId, bool on)
    {
        lock (unhidden)
        {
            if (!(on ? unhidden.Add(playerId) : unhidden.Remove(playerId)))
                return;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(unhiddenPath));
                File.WriteAllText(unhiddenPath, JsonSerializer.Serialize(unhidden.OrderBy(p => p).ToList()));
            }
            catch (Exception e)
            {
                logger.LogWarning(e, "ToolWheel: could not save {path}; the Unhide choice lasts until the next restart", unhiddenPath);
            }
        }
    }

    private void LoadUnhidden()
    {
        try
        {
            if (!File.Exists(unhiddenPath)) return;
            var ids = JsonSerializer.Deserialize<List<ulong>>(File.ReadAllText(unhiddenPath));
            lock (unhidden)
                foreach (var id in ids ?? new List<ulong>()) unhidden.Add(id);
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "ToolWheel: {path} unreadable; no player is opted out of hiding", unhiddenPath);
        }
    }

    // ---------------------------------------------------------------- per-player hotkey
    private int ConfigHotkeyCode() => ToolWheelConfig.HotkeyCode(cfg.Hotkey);

    private int HotkeyCount()
    {
        lock (hotkeys) return hotkeys.Count;
    }

    private int HotkeyOf(ulong playerId)
    {
        lock (hotkeys) return PlayerHotkeys.Effective(hotkeys, playerId, ConfigHotkeyCode());
    }

    private bool HasOwnHotkey(ulong playerId)
    {
        lock (hotkeys) return hotkeys.ContainsKey(playerId);
    }

    /// Tells the client its hotkey. result: "info" (login, menu), "set", "reset" or "refused".
    /// The client applies it at once: no re-injection, no relog.
    private Task SendHotkey(ulong playerId, string result, string reason = null, string note = null, int asked = 0)
    {
        int code = HotkeyOf(playerId), def = ConfigHotkeyCode();
        return SendHudEvent(playerId, "ToolWheel.hotkey", JsonSerializer.Serialize(new
        {
            code,
            label = PlayerHotkeys.Label(code),
            custom = HasOwnHotkey(playerId),
            configCode = def,
            configLabel = PlayerHotkeys.Label(def),
            enabled = cfg.EnableHotkey,
            result,
            reason,
            note,
            asked,
            askedLabel = asked > 0 ? PlayerHotkeys.Label(asked) : null,
        }));
    }

    private async Task OnHotkeyRequest(ulong playerId, string payload)
    {
        var (reset, code) = PlayerHotkeys.ParseRequest(payload);
        if (reset)
        {
            await ResetHotkey(playerId, "wheel");
            return;
        }
        string refusal = !cfg.EnableHotkey ? "the hotkey is turned off on this server (EnableHotkey)" : PlayerHotkeys.Refusal(code);
        if (refusal != null)
        {
            logger.LogInformation("ToolWheel: player {player} hotkey {label} (keyCode {code}) refused: {why}", playerId, PlayerHotkeys.Label(code), code, refusal);
            await SendHotkey(playerId, "refused", refusal, null, code);
            return;
        }
        var note = PlayerHotkeys.Note(code, cfg.QuickKeys.Select(ToolWheelConfig.QuickKeyCode).ToList());
        SaveHotkey(playerId, code);
        logger.LogInformation("ToolWheel: player {player} hotkey set to {label} (keyCode {code}){note}", playerId, PlayerHotkeys.Label(code), code, note != null ? "; " + note : "");
        await SendHotkey(playerId, "set", null, note, code);
    }

    private async Task ResetHotkey(ulong playerId, string why)
    {
        bool had = SaveHotkey(playerId, 0);
        int def = ConfigHotkeyCode();
        logger.LogInformation("ToolWheel: player {player} hotkey reset ({why}) to the config default {label} (keyCode {code}){was}",
            playerId, why, PlayerHotkeys.Label(def), def, had ? "" : "; it was already the default");
        await SendHotkey(playerId, "reset");
    }

    /// Stores a player's hotkey (0 removes it) and writes the file. Returns whether anything changed.
    private bool SaveHotkey(ulong playerId, int code)
    {
        lock (hotkeys)
        {
            bool changed;
            if (code > 0)
            {
                changed = !hotkeys.TryGetValue(playerId, out var old) || old != code;
                hotkeys[playerId] = code;
            }
            else
                changed = hotkeys.Remove(playerId);
            if (!changed)
                return false;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(hotkeysPath));
                File.WriteAllText(hotkeysPath, PlayerHotkeys.Serialize(hotkeys));
            }
            catch (Exception e)
            {
                logger.LogWarning(e, "ToolWheel: could not save {path}; the hotkey lasts until the next restart", hotkeysPath);
            }
            return true;
        }
    }

    private void LoadHotkeys()
    {
        try
        {
            if (!File.Exists(hotkeysPath)) return;
            var read = PlayerHotkeys.Parse(File.ReadAllText(hotkeysPath));
            lock (hotkeys)
                foreach (var kv in read) hotkeys[kv.Key] = kv.Value;
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "ToolWheel: {path} unreadable; every player uses the config hotkey", hotkeysPath);
        }
    }

    /// The wheel entry for an item type, or null when it is not an enabled tool.
    private ToolCatalog.Entry ToolEntry(ulong typeId)
    {
        try
        {
            var def = bank.GetDefinition(typeId);
            if (def == null || !def.Is<NQutils.Def.Tool>())
                return null;
            var tool = bank.GetBaseObject<NQutils.Def.Tool>(typeId);
            if (tool == null || tool.toolDisabled || tool.hidden)
                return null;
            string group = def.Is<NQutils.Def.BuildTool>() ? "build" : def.Is<NQutils.Def.ExploreTool>() ? "explore" : null;
            if (group == null)
                return null;
            return new ToolCatalog.Entry
            {
                Id = typeId,
                Name = def.Name,
                Label = string.IsNullOrWhiteSpace(tool.displayName) ? Humanize(def.Name) : tool.displayName,
                Tooltip = tool.tooltip ?? "",
                Group = group,
                ToolbarDefault = (int)tool.toolbarDefault,
            };
        }
        catch (Exception e)
        {
            logger.LogDebug(e, "ToolWheel: item {id} not readable as a tool", typeId);
            return null;
        }
    }

    /// "ExploreToolMining" -> "Mining"; anything else is split on capitals.
    private static string Humanize(string name)
    {
        if (string.IsNullOrEmpty(name))
            return name;
        foreach (var p in new[] { "ExploreTool", "BuildTool", "Tool" })
            if (name.StartsWith(p, StringComparison.Ordinal) && name.Length > p.Length)
            {
                name = name.Substring(p.Length);
                break;
            }
        var sb = new StringBuilder();
        for (int i = 0; i < name.Length; i++)
        {
            if (i > 0 && char.IsUpper(name[i]) && !char.IsUpper(name[i - 1]))
                sb.Append(' ');
            sb.Append(name[i]);
        }
        return sb.ToString();
    }

    private static string Truncate(string s, int n) =>
        s == null ? "" : s.Length <= n ? s : s.Substring(0, n) + "...";
}
