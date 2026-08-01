require "test_helper"

# What #136 labelled, this enforces. The question every case here asks is the
# same one: if the application forgets to scope a query, what does the database
# hand back? Before row-level security, another room's rows.
class WorkspaceIsolationTest < ActiveSupport::TestCase
  setup do
    @acme = workspace(name: "Acme")
    @globex = workspace(name: "Globex")

    enter(@acme)
    @theirs = channel(slug: "salaries", name: "Salaries")
    Message.create!(channel: @theirs, author: user(name: "Alice", workspace: @acme),
                    body: "everyone gets a raise")

    enter(@globex)
    @ours = channel(slug: "general", name: "General")
  end

  test "a query with no WHERE at all sees one room" do
    assert_equal [ @ours.id ], Channel.pluck(:id)

    enter(@acme)
    assert_equal [ @theirs.id ], Channel.pluck(:id)
  end

  # The control. Without it "Globex saw nothing" is equally well explained by a
  # setup that wrote nothing, and this test could never go red.
  test "the row it cannot see is really there" do
    enter(@acme)

    assert_equal "Salaries", Channel.find_by(slug: "salaries")&.name
    assert_equal 1, Message.count
  end

  test "asking for another room's channel by name finds nothing" do
    assert_nil Channel.find_by(slug: "salaries")
  end

  test "asking for it by id finds nothing either" do
    assert_raises(ActiveRecord::RecordNotFound) { Channel.find(@theirs.id) }
  end

  test "what another room said is not in this one's messages" do
    assert_equal 0, Message.count
    assert_empty Message.where(body: "everyone gets a raise")
  end

  # WITH CHECK, not just USING. A boundary that only closes reading is one
  # somebody can write across on purpose.
  test "a row cannot be put into another room, even deliberately" do
    assert_raises ActiveRecord::StatementInvalid do
      Channel.insert!({ slug: "planted", name: "Planted", workspace_id: @acme.id,
                        memory_uri: "viking://resources/channels/planted/",
                        created_at: Time.current, updated_at: Time.current })
    end
  end

  # The same principle as Memory::Selection refusing rather than defaulting: a
  # question asked with no room in scope has no answer, and the answer it must
  # not get is everybody's.
  test "no room in scope is no rows, rather than every row" do
    enter(nil)

    assert_equal 0, Channel.count
    assert_equal 0, Message.count
    assert_equal 0, MemoryEntry.count
  end

  # The guard on everything else here. A superuser bypasses row-level security
  # even where it is FORCEd, and a local or CI PostgreSQL hands you one — so
  # without this, every case above could pass while the policies did nothing.
  test "the role these queries run as cannot bypass the policies" do
    role, superuser, bypass = ActiveRecord::Base.connection.select_rows(<<~SQL).first
      SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    SQL

    assert_equal Workspace::APP_ROLE, role
    refute superuser, "a superuser sees every room whatever the policy says"
    refute bypass, "BYPASSRLS is the same thing wearing a different name"
  end

  test "every table holding a room's content is covered, not just the ones somebody remembered" do
    covered = ActiveRecord::Base.connection.select_values(<<~SQL)
      SELECT c.relname FROM pg_class c
      JOIN pg_policy p ON p.polrelid = c.oid
      WHERE c.relrowsecurity AND c.relforcerowsecurity
    SQL

    %w[channels memberships messages memory_entries artifacts
       agent_sessions agent_runs run_steps activities].each do |table|
      assert_includes covered, table,
                      "#{table} holds a room's content and nothing stops it crossing rooms"
    end
  end
end
