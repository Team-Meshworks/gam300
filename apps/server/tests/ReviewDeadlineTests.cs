using Spatia.Server.Reviews;

namespace Spatia.Server.Tests;

public sealed class ReviewDeadlineTests
{
    [Test]
    [Arguments(-1L, false)]
    [Arguments(0L, false)]
    [Arguments(1L, true)]
    public async Task ReviewDeadline_OnlyInstantsAfterTheDeadlineAreLate(long ticks, bool expected)
    {
        const long due = 2_000_000_000;
        var submittedAt = DateTimeOffset.FromUnixTimeSeconds(due).AddTicks(ticks);
        await Assert.That(ReviewDeadline.IsLate(submittedAt, due)).IsEqualTo(expected);
    }
}
