require "test_helper"

# The column is carried before it is enforced — row-level security is the next
# step. What this step buys on its own is a boundary the database keeps: a child
# of one workspace cannot reference a parent of another, whatever the code does.
class WorkspaceScopingTest < ActiveSupport::TestCase
  setup do
    @acme = workspace(name: "Acme")
    @globex = workspace(name: "Globex")
  end

  def in_workspace(room)
    was = Current.workspace
    enter(room)
    yield
  ensure
    enter(was)
  end

  test "a room made in a workspace belongs to it, without anybody saying so" do
    room = in_workspace(@acme) { channel(name: "Meetings") }

    assert_equal @acme.id, room.workspace_id
  end

  test "what a record belongs to comes from its parent, not from the request" do
    room = in_workspace(@acme) { channel(name: "Meetings") }
    person = user(name: "Alice", workspace: @acme)

    # The request says Globex; the channel says Acme. The channel is right —
    # otherwise a request could father a message into another room's channel.
    #
    # Saved as the owner because row-level security now refuses this write too,
    # and being refused twice would prove only the outer refusal. That the
    # policy also catches it is #138's subject and its own test.
    said = in_workspace(@globex) do
      as_the_owner { Message.create!(channel: room, author: person, body: "hello") }
    end

    assert_equal @acme.id, said.workspace_id, "a record takes its parent's room, not the request's"
  end

  test "two workspaces can both have a general" do
    first = in_workspace(@acme) { channel(slug: "general", name: "General") }
    second = in_workspace(@globex) { channel(slug: "general", name: "General") }

    assert_equal "general", first.slug
    assert_equal "general", second.slug
    refute_equal first.workspace_id, second.workspace_id
  end

  test "one workspace cannot have two generals" do
    in_workspace(@acme) { channel(slug: "general", name: "General") }

    assert_raises ActiveRecord::RecordInvalid do
      in_workspace(@acme) { Channel.create!(slug: "general", name: "Again") }
    end

    # And the index behind the validation, in case somebody removes it.
    assert_raises ActiveRecord::RecordNotUnique do
      Channel.insert!({ slug: "general", name: "Again", workspace_id: @acme.id,
                        memory_uri: "viking://resources/channels/general/",
                        created_at: Time.current, updated_at: Time.current })
    end if Current.workspace == @acme
  end

  # The point of denormalising the column. Schemas could not have offered this
  # at all: there the two would be different tables with nothing to relate.
  test "the database refuses a message that claims another workspace's channel" do
    room = in_workspace(@acme) { channel(name: "Meetings") }
    person = user(name: "Alice", workspace: @globex)

    # As the owner, so row-level security is out of the way and the composite
    # key is what refuses. Under the app role the policy would refuse first, and
    # this test would pass while proving something else.
    assert_raises ActiveRecord::InvalidForeignKey do
      as_the_owner { Message.insert!({ channel_id: room.id, workspace_id: @globex.id,
                        author_id: person.id, author_type: "User", body: "not from here",
                        created_at: Time.current, updated_at: Time.current }) }
    end
  end

  test "a record with no workspace anywhere is refused rather than defaulted" do
    Current.workspace = nil

    assert_raises ActiveRecord::RecordInvalid do
      Channel.create!(slug: "orphan-#{SecureRandom.hex(3)}", name: "Orphan")
    end
  end
end
