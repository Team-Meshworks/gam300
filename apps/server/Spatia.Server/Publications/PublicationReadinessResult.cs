using Spatia.Server.Projects;

namespace Spatia.Server.Publications;

internal sealed record PublicationReadinessResult(long Revision, PublicationRejection? Rejection,
    bool? CompletionConfirmed, bool? Approved, ProjectAccessFailure? AccessFailure = null);
