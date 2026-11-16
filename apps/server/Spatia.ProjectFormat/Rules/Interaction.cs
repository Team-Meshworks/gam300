namespace Spatia.ProjectFormat;

// Authored WHEN -> DO rules run in preview and keep their array order
public sealed record Interaction(InteractionTrigger When, InteractionAction Do);
