using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using ToolWheel;
using Xunit;

public class PlayerHotkeysTests
{
    private static readonly List<int> DefaultQuick = ToolWheelConfig.DefaultQuickKeys().Select(ToolWheelConfig.QuickKeyCode).ToList();

    [Theory]
    [InlineData(27)] // Esc cancels the prompt
    [InlineData(8)]  // Backspace resets in the prompt
    [InlineData(9)]  // Tab: cursor
    [InlineData(13)] // Enter: chat
    [InlineData(16)]
    [InlineData(17)]
    [InlineData(18)]
    [InlineData(71)] // G: holster, handled by the wheel
    [InlineData(87)]
    [InlineData(65)]
    [InlineData(83)]
    [InlineData(68)]
    [InlineData(32)]
    [InlineData(44)]
    [InlineData(0)]
    [InlineData(-3)]
    [InlineData(300)]
    public void RefusesReservedKeys(int code) => Assert.NotNull(PlayerHotkeys.Refusal(code));

    [Theory]
    [InlineData(52)]  // 4, the default
    [InlineData(220)] // backslash
    [InlineData(53)]
    [InlineData(189)] // -
    [InlineData(116)] // F5
    [InlineData(86)]  // V
    [InlineData(100)] // Num 4
    public void AcceptsOrdinaryKeys(int code) => Assert.Null(PlayerHotkeys.Refusal(code));

    [Theory]
    [InlineData(52, "4")]
    [InlineData(86, "V")]
    [InlineData(220, "\\")]
    [InlineData(189, "-")]
    [InlineData(173, "-")]
    [InlineData(187, "=")]
    [InlineData(116, "F5")]
    [InlineData(100, "Num 4")]
    [InlineData(46, "Del")]
    [InlineData(250, "key 250")]
    public void Labels(int code, string label) => Assert.Equal(label, PlayerHotkeys.Label(code));

    [Fact]
    public void QuickKeyAndSlotKeyConflictsAreNotedNotRefused()
    {
        var five = PlayerHotkeys.Note(53, DefaultQuick);
        Assert.Contains("wedge 5", five);
        Assert.Contains("slot 5", five);
        Assert.Null(PlayerHotkeys.Refusal(53));
        // 0 is wedge 10's key but no stock slot key; - is wedge 11's.
        Assert.DoesNotContain("slot", PlayerHotkeys.Note(48, DefaultQuick).Replace("wedge", ""));
        Assert.Contains("wedge 11", PlayerHotkeys.Note(189, DefaultQuick));
        // Numpad 5 matches the 5 quick key, as in the client.
        Assert.Contains("wedge 5", PlayerHotkeys.Note(101, DefaultQuick));
        Assert.Null(PlayerHotkeys.Note(220, DefaultQuick));
        // Quick-select off: only the stock slot note is left.
        var noQuick = PlayerHotkeys.Note(53, new List<int>());
        Assert.DoesNotContain("wedge", noQuick);
        Assert.Contains("slot 5", noQuick);
    }

    [Fact]
    public void EffectiveFallsBackToTheConfigHotkey()
    {
        var chosen = new Dictionary<ulong, int> { [10000] = 220 };
        Assert.Equal(220, PlayerHotkeys.Effective(chosen, 10000, 52));
        Assert.Equal(52, PlayerHotkeys.Effective(chosen, 10001, 52));
        Assert.Equal(52, PlayerHotkeys.Effective(null, 10000, 52));
    }

    [Theory]
    [InlineData("set:220", false, 220)]
    [InlineData(" set:53 ", false, 53)]
    [InlineData("reset", true, 0)]
    [InlineData("set:", false, 0)]
    [InlineData("set:x", false, 0)]
    [InlineData("", false, 0)]
    [InlineData(null, false, 0)]
    public void ParsesClientRequests(string payload, bool reset, int code)
    {
        var r = PlayerHotkeys.ParseRequest(payload);
        Assert.Equal(reset, r.reset);
        Assert.Equal(code, r.code);
    }

    [Fact]
    public void FileRoundTripsAndDropsBadEntries()
    {
        var chosen = new Dictionary<ulong, int> { [10001] = 53, [10000] = 220 };
        var json = PlayerHotkeys.Serialize(chosen);
        Assert.True(json.IndexOf("10000", StringComparison.Ordinal) < json.IndexOf("10001", StringComparison.Ordinal));
        var back = PlayerHotkeys.Parse(json);
        Assert.Equal(2, back.Count);
        Assert.Equal(220, back[10000]);
        Assert.Equal(53, back[10001]);

        var bad = PlayerHotkeys.Parse("{\"10000\": 27, \"abc\": 52, \"10002\": 86}");
        Assert.Single(bad);
        Assert.Equal(86, bad[10002]);
        Assert.Empty(PlayerHotkeys.Parse(""));
    }

    /// The client keeps its own copy of the refusal and label tables (toolwheel.js) so the prompt
    /// can answer at once. Every key the server refuses must be refused there too, with the same reason.
    [Fact]
    public void ClientScriptRefusesTheSameKeys()
    {
        var js = File.ReadAllText(FindScript());
        var body = Regex.Match(js, @"function hotkeyRefusal\(c\) \{(.*?)\n  \}", RegexOptions.Singleline).Groups[1].Value;
        Assert.False(string.IsNullOrEmpty(body), "hotkeyRefusal not found in toolwheel.js");
        var client = Regex.Matches(body, @"(\d+): ""([^""]+)""").ToDictionary(m => int.Parse(m.Groups[1].Value), m => m.Groups[2].Value);
        for (int c = 1; c <= 255; c++)
        {
            var server = PlayerHotkeys.Refusal(c);
            client.TryGetValue(c, out var mine);
            Assert.True(server == mine, $"keyCode {c}: server says {server ?? "ok"}, client says {mine ?? "ok"}");
        }
    }

    private static string FindScript()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
        {
            var p = Path.Combine(d.FullName, "src", "client", "toolwheel.js");
            if (File.Exists(p)) return p;
        }
        throw new FileNotFoundException("src/client/toolwheel.js");
    }
}
