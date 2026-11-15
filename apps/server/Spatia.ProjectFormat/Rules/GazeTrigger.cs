namespace Spatia.ProjectFormat;

public sealed record GazeTrigger(string TargetId, double Seconds) : ProjectTrigger;
