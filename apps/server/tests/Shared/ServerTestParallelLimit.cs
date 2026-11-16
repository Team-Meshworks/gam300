using TUnit.Core.Interfaces;

[assembly: ParallelLimiter<Spatia.Server.Tests.ServerTestParallelLimit>]

namespace Spatia.Server.Tests;

// Bound database/host setup even when keyed tests bypass TUnit's global CLI limit.
public sealed class ServerTestParallelLimit : IParallelLimit
{
    public int Limit => 4;
}
