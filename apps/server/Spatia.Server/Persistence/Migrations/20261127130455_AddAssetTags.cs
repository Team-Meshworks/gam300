using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class AddAssetTags : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string[]>(
            name: "tags",
            table: "asset_candidates",
            type: "text[]",
            nullable: false,
            defaultValueSql: "'{}'::text[]");

        migrationBuilder.CreateTable(
            name: "asset_tags",
            columns: table => new
            {
                key = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                name = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                created_by = table.Column<Guid>(type: "uuid", nullable: true),
                created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_asset_tags", x => x.key);
                table.CheckConstraint("CK_asset_tag_name", "length(name) BETWEEN 1 AND 40 AND length(key) BETWEEN 1 AND 40");
                table.ForeignKey(
                    name: "FK_asset_tags_AspNetUsers_created_by",
                    column: x => x.created_by,
                    principalTable: "AspNetUsers",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.SetNull);
            });

        migrationBuilder.InsertData(
            table: "asset_tags",
            columns: new[] { "key", "created_at", "created_by", "name" },
            values: new object[,]
            {
                { "earlysingapore", new DateTimeOffset(new DateTime(2026, 11, 27, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), null, "Early Singapore" },
                { "japaneseoccupation", new DateTimeOffset(new DateTime(2026, 11, 27, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), null, "Japanese Occupation" },
                { "modernsingapore", new DateTimeOffset(new DateTime(2026, 11, 27, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), null, "Modern Singapore" },
                { "postwar", new DateTimeOffset(new DateTime(2026, 11, 27, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), null, "Post-war" }
            });

        migrationBuilder.AddCheckConstraint(
            name: "CK_asset_candidate_tags",
            table: "asset_candidates",
            sql: "cardinality(tags) <= 10");

        migrationBuilder.CreateIndex(
            name: "IX_asset_tags_created_by",
            table: "asset_tags",
            column: "created_by");
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(
            name: "asset_tags");

        migrationBuilder.DropCheckConstraint(
            name: "CK_asset_candidate_tags",
            table: "asset_candidates");

        migrationBuilder.DropColumn(
            name: "tags",
            table: "asset_candidates");
    }
}
