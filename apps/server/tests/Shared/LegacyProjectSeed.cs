using Microsoft.EntityFrameworkCore;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

// Historical migration fixtures cannot insert columns introduced by today's model.
internal static class LegacyProjectSeed
{
    public static Task InsertAsync(ApplicationDbContext database, Project project) => database.Database.ExecuteSqlInterpolatedAsync($"""
        INSERT INTO projects (id, organization_id, archived, revision, schema_version, document, updated_at)
        VALUES ({project.Id}, {project.OrganizationId}, {project.IsArchived}, {project.Revision},
            {project.SchemaVersion}, {project.DocumentJson}::jsonb, {project.UpdatedAt})
        """);
}
