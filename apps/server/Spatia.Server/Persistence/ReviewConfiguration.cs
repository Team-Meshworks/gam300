using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Projects;
using Spatia.Server.Reviews;

namespace Spatia.Server.Persistence;

internal sealed class ReviewSubmissionConfiguration : IEntityTypeConfiguration<ReviewSubmission>
{
    public void Configure(EntityTypeBuilder<ReviewSubmission> submission)
    {
        submission.ToTable("review_submissions", table =>
        {
            table.HasCheckConstraint("CK_review_submissions_id", "id <> '00000000-0000-0000-0000-000000000000'::uuid");
            table.HasCheckConstraint("CK_review_submissions_sequence", "sequence > 0");
            table.HasCheckConstraint("CK_review_submissions_revision", $"source_revision BETWEEN 0 AND {Project.MaxRevision}");
            table.HasCheckConstraint("CK_review_submissions_due", $"due_at_unix_seconds BETWEEN {ClassAssignment.MinimumUnixSeconds} AND {ClassAssignment.MaximumUnixSeconds}");
            table.HasCheckConstraint("CK_review_submissions_schema", "schema_version > 0");
            table.HasCheckConstraint("CK_review_submissions_completion", "completion_confirmed IS TRUE");
            table.HasCheckConstraint("CK_review_submissions_digest", "octet_length(request_digest) = 32");
            table.HasCheckConstraint("CK_review_submissions_timestamp", "isfinite(submitted_at)");
            table.HasCheckConstraint("CK_review_submissions_document", """
                (jsonb_typeof(document) = 'object' AND jsonb_typeof(document -> 'projectId') = 'string'
                AND lower(document ->> 'projectId') = project_id::text
                AND jsonb_typeof(document -> 'schemaVersion') = 'number'
                AND document -> 'schemaVersion' = to_jsonb(schema_version)) IS TRUE
                """);
            table.HasCheckConstraint("CK_review_submissions_assets", "review_asset_references_valid(asset_references) IS TRUE");
        });
        submission.HasKey(row => row.Id);
        submission.Property(row => row.Id).HasColumnName("id");
        submission.Property(row => row.ProjectId).HasColumnName("project_id");
        submission.Property(row => row.StudentId).HasColumnName("student_id");
        submission.Property(row => row.Sequence).HasColumnName("sequence");
        submission.Property(row => row.SourceRevision).HasColumnName("source_revision");
        submission.Property(row => row.DueAtUnixSeconds).HasColumnName("due_at_unix_seconds");
        submission.Property(row => row.SchemaVersion).HasColumnName("schema_version");
        submission.Property(row => row.CompletionConfirmed).HasColumnName("completion_confirmed");
        submission.Property(row => row.DocumentJson).HasColumnName("document").HasColumnType("jsonb").IsRequired();
        submission.Property(row => row.AssetReferencesJson).HasColumnName("asset_references").HasColumnType("jsonb").IsRequired();
        submission.Property(row => row.RequestDigest).HasColumnName("request_digest").IsRequired();
        submission.Property(row => row.SubmittedAt).HasColumnName("submitted_at").HasDefaultValueSql("statement_timestamp()");
        submission.HasIndex(row => new { row.ProjectId, row.Sequence }).IsUnique();
        submission.HasOne<ClassAssignmentStudent>().WithMany()
            .HasForeignKey(row => new { row.ProjectId, row.StudentId })
            .HasPrincipalKey(row => new { row.ProjectId, row.StudentId })
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class ReviewDecisionConfiguration : IEntityTypeConfiguration<ReviewDecision>
{
    public void Configure(EntityTypeBuilder<ReviewDecision> decision)
    {
        decision.ToTable("review_decisions", table =>
        {
            table.HasCheckConstraint("CK_review_decisions_id", "id <> '00000000-0000-0000-0000-000000000000'::uuid");
            table.HasCheckConstraint("CK_review_decisions_sequence", "sequence > 0");
            table.HasCheckConstraint("CK_review_decisions_outcome", "outcome IN ('approved', 'returned', 'revoked')");
            table.HasCheckConstraint("CK_review_decisions_feedback", "length(feedback) <= 4000");
            table.HasCheckConstraint("CK_review_decisions_digest", "octet_length(request_digest) = 32");
            table.HasCheckConstraint("CK_review_decisions_timestamp", "isfinite(decided_at)");
        });
        decision.HasKey(row => row.Id);
        decision.Property(row => row.Id).HasColumnName("id");
        decision.Property(row => row.SubmissionId).HasColumnName("submission_id");
        decision.Property(row => row.EducatorId).HasColumnName("educator_id");
        decision.Property(row => row.Sequence).HasColumnName("sequence");
        decision.Property(row => row.Outcome).HasColumnName("outcome").HasMaxLength(16).IsRequired();
        decision.Property(row => row.Feedback).HasColumnName("feedback").HasMaxLength(4000).IsRequired();
        decision.Property(row => row.RequestDigest).HasColumnName("request_digest").IsRequired();
        decision.Property(row => row.DecidedAt).HasColumnName("decided_at").HasDefaultValueSql("statement_timestamp()");
        decision.HasIndex(row => new { row.SubmissionId, row.Sequence }).IsUnique();
        decision.HasOne<ReviewSubmission>().WithMany().HasForeignKey(row => row.SubmissionId).OnDelete(DeleteBehavior.Restrict);
        decision.HasOne<ApplicationUser>().WithMany().HasForeignKey(row => row.EducatorId).OnDelete(DeleteBehavior.Restrict);
    }
}
