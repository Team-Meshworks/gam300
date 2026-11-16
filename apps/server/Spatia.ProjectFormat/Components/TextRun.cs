namespace Spatia.ProjectFormat;

// Render literal text with supported marks rather than interpreting authored HTML
public sealed record TextRun(string Text, TextMark[] Marks);
