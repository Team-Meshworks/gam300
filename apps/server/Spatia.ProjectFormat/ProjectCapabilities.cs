namespace Spatia.ProjectFormat;

public static class ProjectCapabilities
{
    // Storage preserves known variants; preview and publication check the actual player build
    public static IReadOnlyList<CapabilityIssue> Missing(IAuthoredProject project, IReadOnlySet<string> supported)
    {
        // Start with the saved format version; v1 uses only the baseline model-viewing features
        // Structural and reference validation must already have succeeded before this check
        var issues = new List<CapabilityIssue>();
        if (project is LegacyProject { SchemaVersion: 1 })
        {
            return issues;
        }

        // Only inspect the known v2 contract so a future version cannot silently pass as supported
        if (project is not ContentProject { SchemaVersion: 2 } content)
        {
            throw new ArgumentException("Capabilities require a validated supported project", nameof(project));
        }

        // Compare each authored requirement against this build's supported feature names
        // Collect every missing location rather than stopping at the first unavailable feature
        void Need(string capability, string path)
        {
            // Retain field paths so callers can locate the unsupported authored feature
            if (!supported.Contains(capability))
            {
                issues.Add(new(path, capability));
            }
        }

        // A single-scene player cannot execute the whole project when further scenes are authored
        if (content.Scenes.Length > 1)
        {
            Need("multipleScenes", "project.scenes");
        }

        // Walk scenes in saved order, checking their objects before their interaction rules
        // Array indexes keep diagnostics tied to the original document without modifying it
        for (var i = 0; i < content.Scenes.Length; i++)
        {
            var scene = content.Scenes[i];
            var path = $"project.scenes[{i}]";

            // Every object can require visibility handling as well as attached content playback
            for (var j = 0; j < scene.Objects.Length; j++)
            {
                var item = scene.Objects[j];
                var itemPath = $"{path}.objects[{j}]";

                // Visible objects match the baseline; hidden objects need explicit player support
                if (!item.Visible)
                {
                    Need("visibility", $"{itemPath}.visible");
                }


                // Translate record types into the same stable capability names used by the browser
                // An unexpected subtype stays unsupported instead of disappearing from the result
                for (var k = 0; k < item.Components.Length; k++)
                {
                    var kind = item.Components[k] switch
                    {
                        HotspotComponent => "hotspot",
                        TextComponent => "text",
                        ImageComponent => "image",
                        AudioComponent => "audio",
                        VideoComponent => "video",
                        NavigationPointComponent => "navigationPoint",
                        _ => "unknown",
                    };
                    Need($"content:{kind}", $"{itemPath}.components[{k}]");
                    var componentPath = $"{itemPath}.components[{k}]";
                    if (item.Components[k] is AudioComponent audio)
                    {
                        // Supporting audio playback does not imply support for spatial attenuation
                        Need($"audio:{audio.Mode.ToString().ToLowerInvariant()}", $"{componentPath}.mode");
                    }


                    // Text playback also needs support for each authored formatting mark
                    // Retain run and mark indexes so feedback can identify the exact unsupported span
                    if (item.Components[k] is TextComponent text)
                    {
                        for (var run = 0; run < text.Runs.Length; run++)
                        {
                            for (var mark = 0; mark < text.Runs[run].Marks.Length; mark++)
                            {
                                Need($"text:{text.Runs[run].Marks[mark].ToString().ToLowerInvariant()}",
                                    $"{componentPath}.runs[{run}].marks[{mark}]");
                            }
                        }
                    }
                }
            }

            // Check execution requirements only for enabled rules after collecting content requirements
            for (var j = 0; j < scene.Rules.Length; j++)
            {
                var rule = scene.Rules[j];
                if (!rule.Enabled)
                {
                    // Disabled rules remain in storage but require no runtime execution support
                    continue;
                }

                // The trigger decides when a rule runs; action support is checked separately below
                var rulePath = $"{path}.rules[{j}]";
                var trigger = rule.Trigger switch
                {
                    ClickTrigger => "click",
                    ZoneEnterTrigger => "zoneEnter",
                    SceneStartTrigger => "sceneStart",
                    ElapsedTrigger => "elapsed",
                    GazeTrigger => "gaze",
                    PanelCloseTrigger => "panelClose",
                    _ => "unknown",
                };
                Need($"trigger:{trigger}", $"{rulePath}.trigger");

                // Inspect every action in authored order without running or reordering any effects
                for (var k = 0; k < rule.Actions.Length; k++)
                {
                    var action = rule.Actions[k] switch
                    {
                        ShowPanelAction => "showPanel",
                        PlayMediaAction => "playMedia",
                        MoveCameraAction => "moveCamera",
                        SetVisibleAction => "setVisible",
                        NavigateSceneAction => "navigateScene",
                        OpenLinkAction => "openLink",
                        _ => "unknown",
                    };
                    Need($"action:{action}", $"{rulePath}.actions[{k}]");
                }
            }
        }

        // An empty result means the build covers every requirement in this already-validated document
        // Callers decide how to present missing features before allowing preview or publication
        return issues;
    }
}
