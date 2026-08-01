# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_08_01_160001) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"

  create_table "active_storage_attachments", force: :cascade do |t|
    t.bigint "blob_id", null: false
    t.datetime "created_at", null: false
    t.string "name", null: false
    t.bigint "record_id", null: false
    t.string "record_type", null: false
    t.index ["blob_id"], name: "index_active_storage_attachments_on_blob_id"
    t.index ["record_type", "record_id", "name", "blob_id"], name: "index_active_storage_attachments_uniqueness", unique: true
  end

  create_table "active_storage_blobs", force: :cascade do |t|
    t.bigint "byte_size", null: false
    t.string "checksum"
    t.string "content_type"
    t.datetime "created_at", null: false
    t.string "filename", null: false
    t.string "key", null: false
    t.text "metadata"
    t.string "service_name", null: false
    t.index ["key"], name: "index_active_storage_blobs_on_key", unique: true
  end

  create_table "active_storage_variant_records", force: :cascade do |t|
    t.bigint "blob_id", null: false
    t.string "variation_digest", null: false
    t.index ["blob_id", "variation_digest"], name: "index_active_storage_variant_records_uniqueness", unique: true
  end

  create_table "activities", force: :cascade do |t|
    t.string "action", null: false
    t.bigint "actor_id", null: false
    t.string "actor_type", null: false
    t.datetime "created_at", null: false
    t.jsonb "metadata", default: {}, null: false
    t.bigint "subject_id"
    t.string "subject_type"
    t.bigint "workspace_id", null: false
    t.index ["actor_type", "actor_id"], name: "index_activities_on_actor"
    t.index ["created_at"], name: "index_activities_on_created_at"
    t.index ["subject_type", "subject_id"], name: "index_activities_on_subject"
    t.index ["workspace_id"], name: "index_activities_on_workspace_id"
  end

  create_table "agent_runs", force: :cascade do |t|
    t.bigint "agent_session_id", null: false
    t.integer "context_size"
    t.integer "context_used"
    t.decimal "cost", precision: 12, scale: 6
    t.datetime "created_at", null: false
    t.datetime "distilled_at"
    t.datetime "ended_at"
    t.string "model"
    t.datetime "started_at"
    t.string "status", default: "queued", null: false
    t.bigint "trigger_message_id"
    t.datetime "updated_at", null: false
    t.bigint "workspace_id", null: false
    t.index ["agent_session_id", "created_at"], name: "index_agent_runs_on_agent_session_id_and_created_at"
    t.index ["agent_session_id"], name: "index_agent_runs_on_agent_session_id"
    t.index ["id", "workspace_id"], name: "index_agent_runs_on_id_and_workspace_id", unique: true
    t.index ["trigger_message_id"], name: "index_agent_runs_on_trigger_message_id"
    t.index ["workspace_id"], name: "index_agent_runs_on_workspace_id"
  end

  create_table "agent_sessions", force: :cascade do |t|
    t.string "agent_kind", default: "claude_code", null: false
    t.bigint "channel_id", null: false
    t.datetime "created_at", null: false
    t.datetime "ended_at"
    t.string "external_id"
    t.datetime "started_at"
    t.string "status", default: "idle", null: false
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.bigint "workspace_id", null: false
    t.index ["channel_id"], name: "index_agent_sessions_on_channel_id"
    t.index ["id", "workspace_id"], name: "index_agent_sessions_on_id_and_workspace_id", unique: true
    t.index ["user_id", "channel_id"], name: "index_agent_sessions_on_user_id_and_channel_id"
    t.index ["user_id"], name: "index_agent_sessions_on_user_id"
    t.index ["workspace_id"], name: "index_agent_sessions_on_workspace_id"
  end

  create_table "artifacts", force: :cascade do |t|
    t.bigint "agent_run_id"
    t.bigint "channel_id", null: false
    t.datetime "created_at", null: false
    t.string "kind"
    t.string "name", null: false
    t.datetime "updated_at", null: false
    t.bigint "workspace_id", null: false
    t.index ["agent_run_id"], name: "index_artifacts_on_agent_run_id"
    t.index ["channel_id"], name: "index_artifacts_on_channel_id"
    t.index ["workspace_id"], name: "index_artifacts_on_workspace_id"
  end

  create_table "channels", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.string "memory_uri", null: false
    t.string "name", null: false
    t.text "purpose"
    t.string "slug", null: false
    t.datetime "updated_at", null: false
    t.string "visibility", default: "open", null: false
    t.bigint "workspace_id", null: false
    t.index ["id", "workspace_id"], name: "index_channels_on_id_and_workspace_id", unique: true
    t.index ["workspace_id", "slug"], name: "index_channels_on_workspace_id_and_slug", unique: true
    t.index ["workspace_id"], name: "index_channels_on_workspace_id"
  end

  create_table "memberships", force: :cascade do |t|
    t.bigint "channel_id", null: false
    t.datetime "created_at", null: false
    t.string "role", default: "member", null: false
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.bigint "workspace_id", null: false
    t.index ["channel_id"], name: "index_memberships_on_channel_id"
    t.index ["user_id", "channel_id"], name: "index_memberships_on_user_id_and_channel_id", unique: true
    t.index ["user_id"], name: "index_memberships_on_user_id"
    t.index ["workspace_id"], name: "index_memberships_on_workspace_id"
  end

  create_table "memory_entries", force: :cascade do |t|
    t.text "abstract"
    t.bigint "author_id"
    t.string "author_type"
    t.bigint "channel_id", null: false
    t.datetime "created_at", null: false
    t.text "detail"
    t.text "overview"
    t.bigint "source_id"
    t.string "source_type"
    t.datetime "superseded_at"
    t.string "title", null: false
    t.string "trust", default: "agent", null: false
    t.datetime "updated_at", null: false
    t.string "uri", null: false
    t.bigint "workspace_id", null: false
    t.index ["author_type", "author_id"], name: "index_memory_entries_on_author"
    t.index ["channel_id", "superseded_at"], name: "index_memory_entries_on_channel_id_and_superseded_at"
    t.index ["channel_id"], name: "index_memory_entries_on_channel_id"
    t.index ["source_type", "source_id"], name: "index_memory_entries_on_source"
    t.index ["workspace_id", "uri"], name: "index_memory_entries_on_workspace_id_and_uri", unique: true
    t.index ["workspace_id"], name: "index_memory_entries_on_workspace_id"
  end

  create_table "messages", force: :cascade do |t|
    t.bigint "author_id", null: false
    t.string "author_type", null: false
    t.text "body", null: false
    t.bigint "channel_id", null: false
    t.datetime "created_at", null: false
    t.bigint "parent_id"
    t.datetime "updated_at", null: false
    t.bigint "workspace_id", null: false
    t.index ["author_type", "author_id"], name: "index_messages_on_author"
    t.index ["channel_id", "created_at"], name: "index_messages_on_channel_id_and_created_at"
    t.index ["channel_id"], name: "index_messages_on_channel_id"
    t.index ["parent_id"], name: "index_messages_on_parent_id"
    t.index ["workspace_id"], name: "index_messages_on_workspace_id"
  end

  create_table "run_steps", force: :cascade do |t|
    t.bigint "agent_run_id", null: false
    t.datetime "created_at", null: false
    t.string "kind", null: false
    t.string "label"
    t.jsonb "payload", default: {}, null: false
    t.bigint "workspace_id", null: false
    t.index ["agent_run_id", "created_at"], name: "index_run_steps_on_agent_run_id_and_created_at"
    t.index ["agent_run_id"], name: "index_run_steps_on_agent_run_id"
    t.index ["workspace_id"], name: "index_run_steps_on_workspace_id"
  end

  create_table "users", force: :cascade do |t|
    t.string "avatar_url"
    t.datetime "created_at", null: false
    t.string "email", null: false
    t.string "name"
    t.string "provider", null: false
    t.string "uid", null: false
    t.datetime "updated_at", null: false
    t.index ["email"], name: "index_users_on_email", unique: true
    t.index ["provider", "uid"], name: "index_users_on_provider_and_uid", unique: true
  end

  create_table "workspace_memberships", force: :cascade do |t|
    t.string "api_token"
    t.datetime "created_at", null: false
    t.string "role", default: "member", null: false
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.bigint "workspace_id", null: false
    t.index ["api_token"], name: "index_workspace_memberships_on_api_token", unique: true
    t.index ["user_id", "workspace_id"], name: "index_workspace_memberships_on_user_id_and_workspace_id", unique: true
    t.index ["user_id"], name: "index_workspace_memberships_on_user_id"
    t.index ["workspace_id"], name: "index_workspace_memberships_on_workspace_id"
  end

  create_table "workspaces", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.string "name", null: false
    t.string "openviking_api_key"
    t.string "openviking_url"
    t.string "slug", null: false
    t.datetime "updated_at", null: false
    t.index ["slug"], name: "index_workspaces_on_slug", unique: true
  end

  add_foreign_key "active_storage_attachments", "active_storage_blobs", column: "blob_id"
  add_foreign_key "active_storage_variant_records", "active_storage_blobs", column: "blob_id"
  add_foreign_key "activities", "workspaces"
  add_foreign_key "agent_runs", "agent_sessions"
  add_foreign_key "agent_runs", "agent_sessions", column: ["agent_session_id", "workspace_id"], primary_key: ["id", "workspace_id"]
  add_foreign_key "agent_runs", "messages", column: "trigger_message_id"
  add_foreign_key "agent_runs", "workspaces"
  add_foreign_key "agent_sessions", "channels"
  add_foreign_key "agent_sessions", "channels", column: ["channel_id", "workspace_id"], primary_key: ["id", "workspace_id"]
  add_foreign_key "agent_sessions", "users"
  add_foreign_key "agent_sessions", "workspaces"
  add_foreign_key "artifacts", "agent_runs"
  add_foreign_key "artifacts", "channels"
  add_foreign_key "artifacts", "channels", column: ["channel_id", "workspace_id"], primary_key: ["id", "workspace_id"]
  add_foreign_key "artifacts", "workspaces"
  add_foreign_key "channels", "workspaces"
  add_foreign_key "memberships", "channels"
  add_foreign_key "memberships", "channels", column: ["channel_id", "workspace_id"], primary_key: ["id", "workspace_id"]
  add_foreign_key "memberships", "users"
  add_foreign_key "memberships", "workspaces"
  add_foreign_key "memory_entries", "channels"
  add_foreign_key "memory_entries", "channels", column: ["channel_id", "workspace_id"], primary_key: ["id", "workspace_id"]
  add_foreign_key "memory_entries", "workspaces"
  add_foreign_key "messages", "channels"
  add_foreign_key "messages", "channels", column: ["channel_id", "workspace_id"], primary_key: ["id", "workspace_id"]
  add_foreign_key "messages", "messages", column: "parent_id"
  add_foreign_key "messages", "workspaces"
  add_foreign_key "run_steps", "agent_runs"
  add_foreign_key "run_steps", "agent_runs", column: ["agent_run_id", "workspace_id"], primary_key: ["id", "workspace_id"]
  add_foreign_key "run_steps", "workspaces"
  add_foreign_key "workspace_memberships", "users"
  add_foreign_key "workspace_memberships", "workspaces"
end
