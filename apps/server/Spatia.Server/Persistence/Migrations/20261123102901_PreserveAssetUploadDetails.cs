using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class PreserveAssetUploadDetails : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "catalogue_category",
            table: "asset_candidates",
            type: "character varying(40)",
            maxLength: 40,
            nullable: true);

        migrationBuilder.AddColumn<string>(
            name: "catalogue_license",
            table: "asset_candidates",
            type: "character varying(2000)",
            maxLength: 2000,
            nullable: true);

        migrationBuilder.AddColumn<string>(
            name: "catalogue_name",
            table: "asset_candidates",
            type: "character varying(120)",
            maxLength: 120,
            nullable: true);

        migrationBuilder.AddColumn<string>(
            name: "catalogue_review_notes",
            table: "asset_candidates",
            type: "character varying(2000)",
            maxLength: 2000,
            nullable: true);

        migrationBuilder.AddColumn<string>(
            name: "catalogue_source",
            table: "asset_candidates",
            type: "character varying(2000)",
            maxLength: 2000,
            nullable: true);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(
            name: "catalogue_category",
            table: "asset_candidates");

        migrationBuilder.DropColumn(
            name: "catalogue_license",
            table: "asset_candidates");

        migrationBuilder.DropColumn(
            name: "catalogue_name",
            table: "asset_candidates");

        migrationBuilder.DropColumn(
            name: "catalogue_review_notes",
            table: "asset_candidates");

        migrationBuilder.DropColumn(
            name: "catalogue_source",
            table: "asset_candidates");
    }
}
