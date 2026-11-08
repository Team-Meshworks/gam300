using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class AddAssignmentEditing : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<Guid>(
            name: "last_edit_actor_id",
            table: "class_assignments",
            type: "uuid",
            nullable: true);

        migrationBuilder.AddColumn<byte[]>(
            name: "last_edit_digest",
            table: "class_assignments",
            type: "bytea",
            nullable: true);

        migrationBuilder.AddColumn<Guid>(
            name: "last_edit_id",
            table: "class_assignments",
            type: "uuid",
            nullable: true);

        migrationBuilder.AddColumn<long>(
            name: "revision",
            table: "class_assignments",
            type: "bigint",
            nullable: false,
            defaultValue: 0L);

        migrationBuilder.AddColumn<bool>(
            name: "is_active",
            table: "class_assignment_students",
            type: "boolean",
            nullable: false,
            defaultValue: true);

        migrationBuilder.AddColumn<bool>(
            name: "originally_assigned",
            table: "class_assignment_students",
            type: "boolean",
            nullable: false,
            defaultValue: true);

        migrationBuilder.AddCheckConstraint(
            name: "CK_class_assignments_last_edit",
            table: "class_assignments",
            sql: "(last_edit_id IS NULL AND last_edit_actor_id IS NULL AND last_edit_digest IS NULL) OR (last_edit_id IS NOT NULL AND last_edit_actor_id IS NOT NULL AND last_edit_digest IS NOT NULL AND octet_length(last_edit_digest) = 32)");

        migrationBuilder.AddCheckConstraint(
            name: "CK_class_assignments_revision",
            table: "class_assignments",
            sql: "revision BETWEEN 0 AND 9007199254740991");
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
                DO $guard$
                BEGIN
                    IF EXISTS (SELECT 1 FROM class_assignments WHERE revision <> 0)
                       OR EXISTS (SELECT 1 FROM class_assignment_students WHERE NOT is_active OR NOT originally_assigned) THEN
                        RAISE EXCEPTION 'Cannot remove assignment editing state while edited assignments exist' USING ERRCODE = '23514';
                    END IF;
                END $guard$;
                """);
        migrationBuilder.DropCheckConstraint(
            name: "CK_class_assignments_last_edit",
            table: "class_assignments");

        migrationBuilder.DropCheckConstraint(
            name: "CK_class_assignments_revision",
            table: "class_assignments");

        migrationBuilder.DropColumn(
            name: "last_edit_actor_id",
            table: "class_assignments");

        migrationBuilder.DropColumn(
            name: "last_edit_digest",
            table: "class_assignments");

        migrationBuilder.DropColumn(
            name: "last_edit_id",
            table: "class_assignments");

        migrationBuilder.DropColumn(
            name: "revision",
            table: "class_assignments");

        migrationBuilder.DropColumn(
            name: "is_active",
            table: "class_assignment_students");

        migrationBuilder.DropColumn(
            name: "originally_assigned",
            table: "class_assignment_students");
    }
}
