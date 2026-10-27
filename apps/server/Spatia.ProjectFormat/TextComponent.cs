namespace Spatia.ProjectFormat;

public sealed record TextComponent(string Id, TextRun[] Runs, string Caption) : ContentComponent(Id);
