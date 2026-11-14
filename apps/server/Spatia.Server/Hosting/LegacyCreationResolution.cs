using Spatia.Server.Persistence;

namespace Spatia.Server.Hosting;

internal sealed record LegacyCreationResolution(bool IsDecision, Guid? ExistingId, Guid? PreviousOperationId)
{
    internal Guid? ChooseOperationId(LegacyCreationBinding? binding) => binding?.OperationId
        ?? (binding is null && ExistingId is null ? Guid.NewGuid() : null);

    internal bool Matches(LegacyCreationBinding binding) => !IsDecision
        || (ExistingId is { } existing ? binding.OperationId is null && binding.ResourceId == existing
            : binding.OperationId is not null && binding.PreviousOperationId == PreviousOperationId);
}
