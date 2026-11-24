CREATE TYPE "AcademicYearStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');
CREATE TYPE "SchoolTermStatus" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETED');
CREATE TYPE "SchoolGradeLevelStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "SchoolClassSectionStatus" AS ENUM ('PLANNED', 'ACTIVE', 'CLOSED');

CREATE TABLE "school_profiles" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "school_code" VARCHAR(40),
    "time_zone" VARCHAR(80) NOT NULL DEFAULT 'Africa/Nairobi',
    "week_starts_on" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "school_profiles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "school_profiles_week_starts_on_check" CHECK ("week_starts_on" BETWEEN 1 AND 7),
    CONSTRAINT "school_profiles_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "school_profiles_organisation_id_key" ON "school_profiles"("organisation_id");
CREATE UNIQUE INDEX "school_profiles_organisation_id_school_code_key" ON "school_profiles"("organisation_id", "school_code");

CREATE TABLE "school_academic_years" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "status" "AcademicYearStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "school_academic_years_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "school_academic_years_date_range_check" CHECK ("ends_on" > "starts_on"),
    CONSTRAINT "school_academic_years_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "school_academic_years_id_organisation_id_key" ON "school_academic_years"("id", "organisation_id");
CREATE UNIQUE INDEX "school_academic_years_organisation_id_name_key" ON "school_academic_years"("organisation_id", "name");
CREATE INDEX "school_academic_years_organisation_id_status_starts_on_idx" ON "school_academic_years"("organisation_id", "status", "starts_on");

CREATE TABLE "school_terms" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "sequence" INTEGER NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "status" "SchoolTermStatus" NOT NULL DEFAULT 'PLANNED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "school_terms_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "school_terms_sequence_check" CHECK ("sequence" > 0),
    CONSTRAINT "school_terms_date_range_check" CHECK ("ends_on" > "starts_on"),
    CONSTRAINT "school_terms_academic_year_id_organisation_id_fkey" FOREIGN KEY ("academic_year_id", "organisation_id") REFERENCES "school_academic_years"("id", "organisation_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "school_terms_id_organisation_id_key" ON "school_terms"("id", "organisation_id");
CREATE UNIQUE INDEX "school_terms_organisation_id_academic_year_id_name_key" ON "school_terms"("organisation_id", "academic_year_id", "name");
CREATE UNIQUE INDEX "school_terms_organisation_id_academic_year_id_sequence_key" ON "school_terms"("organisation_id", "academic_year_id", "sequence");
CREATE INDEX "school_terms_organisation_id_academic_year_id_starts_on_idx" ON "school_terms"("organisation_id", "academic_year_id", "starts_on");

CREATE TABLE "school_grade_levels" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 1,
    "status" "SchoolGradeLevelStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "school_grade_levels_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "school_grade_levels_sort_order_check" CHECK ("sort_order" > 0),
    CONSTRAINT "school_grade_levels_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "school_grade_levels_id_organisation_id_key" ON "school_grade_levels"("id", "organisation_id");
CREATE UNIQUE INDEX "school_grade_levels_organisation_id_name_key" ON "school_grade_levels"("organisation_id", "name");
CREATE UNIQUE INDEX "school_grade_levels_organisation_id_code_key" ON "school_grade_levels"("organisation_id", "code");
CREATE INDEX "school_grade_levels_organisation_id_status_sort_order_idx" ON "school_grade_levels"("organisation_id", "status", "sort_order");

CREATE TABLE "school_class_sections" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "grade_level_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "status" "SchoolClassSectionStatus" NOT NULL DEFAULT 'PLANNED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "school_class_sections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "school_class_sections_name_check" CHECK (length(trim("name")) > 0),
    CONSTRAINT "school_class_sections_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "school_class_sections_academic_year_id_organisation_id_fkey" FOREIGN KEY ("academic_year_id", "organisation_id") REFERENCES "school_academic_years"("id", "organisation_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "school_class_sections_grade_level_id_organisation_id_fkey" FOREIGN KEY ("grade_level_id", "organisation_id") REFERENCES "school_grade_levels"("id", "organisation_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "school_class_sections_id_organisation_id_key" ON "school_class_sections"("id", "organisation_id");
CREATE UNIQUE INDEX "school_class_sections_organisation_id_academic_year_id_grade_level_id_name_key" ON "school_class_sections"("organisation_id", "academic_year_id", "grade_level_id", "name");
CREATE INDEX "school_class_sections_organisation_id_academic_year_id_status_idx" ON "school_class_sections"("organisation_id", "academic_year_id", "status");

INSERT INTO "permissions" ("id", "key", "description")
VALUES (gen_random_uuid(), 'school.read', 'View school settings and academic structure')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT "roles"."id", "permissions"."id"
FROM "roles"
CROSS JOIN "permissions"
WHERE "roles"."name" IN ('Organisation Owner', 'Organisation Administrator', 'Manager')
  AND "permissions"."key" = 'school.read'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;