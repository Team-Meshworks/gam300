namespace Spatia.ProjectFormat;

public sealed record SetVisibleAction(string ObjectId, bool Visible) : ProjectAction;
