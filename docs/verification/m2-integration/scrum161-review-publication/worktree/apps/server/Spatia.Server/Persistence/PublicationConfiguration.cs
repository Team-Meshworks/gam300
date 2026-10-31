using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Spatia.Server.Accounts;
using Spatia.Server.Projects;
using Spatia.Server.Publications;

namespace Spatia.Server.Persistence;

/// <summary>Maps the immutable publication ledger; migration SQL enforces its update prohibition</summary>
internal sealed class PublicationConfiguration : IEntityTypeConfiguration<Publication>
{
    public void Configure(EntityTypeBuilder<Publication> publication)
    {
        publication.ToTable("publications", table =>
        {
            table.HasTrigger("TR_publications_immutable");
            table.HasCheckConstraint("CK_publications_id", "id <> '00000000-0000-0000-0000-000000000000'::uuid");
            table.HasCheckConstraint("CK_publications_source_revision", "source_revision BETWEEN 0 AND 9007199254740991");
            table.HasCheckConstraint("CK_publications_schema_version", "schema_version > 0");
            table.HasCheckConstraint("CK_publications_document", """
                (
                    jsonb_typeof(document) = 'object'
                    AND jsonb_typeof(document -> 'projectId') = 'string'
                    AND lower(document ->> 'projectId') = project_id::text
                    AND jsonb_typeof(document -> 'schemaVersion') = 'number'
                    AND document -> 'schemaVersion' = to_jsonb(schema_version)
                ) IS TRUE
                """);
            table.HasCheckConstraint("CK_publications_asset_references", "publication_asset_references_valid(asset_references) IS TRUE");
            table.HasCheckConstraint("CK_publications_request_digest", "octet_length(request_digest) = 32");
            table.HasCheckConstraint("CK_publications_created_at", "isfinite(created_at)");
        });
        publication.HasKey(record => record.Id);
        publication.Property(record => record.Id).HasColumnName("id").ValueGeneratedNever();
        publication.Property(record => record.ProjectId).HasColumnName("project_id");
        publication.Property(record => record.PublishedById).HasColumnName("published_by_id");
        publication.Property(record => record.SourceRevision).HasColumnName("source_revision");
        publication.Property(record => record.SchemaVersion).HasColumnName("schema_version");
        publication.Property(record => record.DocumentJson).HasColumnName("document").HasColumnType("jsonb").IsRequired();
        publication.Property(record => record.AssetReferencesJson).HasColumnName("asset_references").HasColumnType("jsonb").IsRequired();
        publication.Property(record => record.RequestDigest).HasColumnName("request_digest").IsRequired();
        publication.Property(record => record.CreatedAt).HasColumnName("created_at")
            .HasColumnType("timestamp with time zone").HasDefaultValueSql("statement_timestamp()");
        publication.HasIndex(record => new { record.ProjectId, record.SourceRevision });
        publication.HasOne<Project>().WithMany().HasForeignKey(record => record.ProjectId).OnDelete(DeleteBehavior.Restrict);
        publication.HasOne<ApplicationUser>().WithMany().HasForeignKey(record => record.PublishedById).OnDelete(DeleteBehavior.Restrict);
    }
}
