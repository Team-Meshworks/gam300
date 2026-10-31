namespace Spatia.Server.Reviews;

internal static class ReviewDeadline
{
    internal static bool IsLate(DateTimeOffset submittedAt, long dueAtUnixSeconds) =>
        submittedAt > DateTimeOffset.FromUnixTimeSeconds(dueAtUnixSeconds);
}
