namespace Spatia.ProjectFormat;

// Preserve action order and keep playback progress outside authored rules
public sealed record ProjectRule(string Id, bool Enabled, ProjectTrigger Trigger, ProjectAction[] Actions);
