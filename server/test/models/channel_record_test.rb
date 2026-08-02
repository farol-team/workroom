require "test_helper"

# One row of a room's journal. What it has to be is a row nobody can change
# afterwards — a chain whose links can be edited records nothing at all.
class ChannelRecordTest < ActiveSupport::TestCase
  setup do
    @channel = channel
  end

  def entry(seq: 1, prev_hash: "0" * 64, room: @channel)
    ChannelRecord.create!(channel: room, seq:, prev_hash:, kind: "message.created",
                          entry_hash: Digest::SHA256.hexdigest("entry #{SecureRandom.hex(8)}"))
  end

  test "an entry cannot be rewritten once it is written" do
    written = entry

    assert_raises(ActiveRecord::ReadOnlyRecord) { written.update!(kind: "something.else") }
  end

  test "an entry cannot be removed by itself" do
    written = entry

    assert_raises(ActiveRecord::ReadOnlyRecord) { written.destroy }
    assert ChannelRecord.exists?(written.id), "the entry is still there, refused rather than deleted"
  end

  # It goes when the room goes, and only then. An entry outliving its channel
  # would be a record of a conversation nobody can reach.
  test "destroying the room takes its journal with it" do
    written = entry

    @channel.destroy!

    assert_not ChannelRecord.exists?(written.id)
  end

  # And it is the association that takes it, not the database. The composite key
  # to channels is NO ACTION, like every sibling's, so a channel deleted behind
  # Active Record's back is refused while its journal stands. Worth pinning
  # because the opposite reading is tempting: drop `dependent:` believing the
  # foreign key covers it and room deletion stops working altogether.
  test "the database will not clear a journal by itself" do
    entry

    assert_raises ActiveRecord::InvalidForeignKey do
      as_the_owner do
        ActiveRecord::Base.connection.execute("DELETE FROM channels WHERE id = #{@channel.id}")
      end
    end
  end

  # There is nothing to update, so there is no column claiming there might be.
  # The absence is the guarantee: no code path can quietly start touching one.
  test "the row has no updated_at, because it is never updated" do
    assert_not_includes ChannelRecord.column_names, "updated_at"
  end

  # The channel is the source, not the request. Written from inside another
  # workspace on purpose: with the two agreeing — which is the usual case —
  # this assertion would hold even if the value came from Current.
  #
  # Saved as the owner because row-level security refuses a write into a room
  # the request is not in, and being refused there would prove only that.
  test "the entry takes its workspace from the room, not from the request" do
    mine = Current.workspace
    written = nil

    enter(workspace(name: "Globex"))
    as_the_owner { written = entry }

    assert_equal mine.id, written.workspace_id
    assert_equal @channel.workspace_id, written.workspace_id
  end

  # The journal joins the boundary like every other table holding a room's
  # content: another workspace querying with no WHERE at all sees none of it.
  test "another workspace cannot see this room's journal" do
    written = entry
    mine = Current.workspace

    enter(workspace(name: "Globex"))
    assert_equal 0, ChannelRecord.count
    assert_nil ChannelRecord.find_by(entry_hash: written.entry_hash)

    # The control: the row it cannot see is really there.
    enter(mine)
    assert_equal 1, ChannelRecord.count
  end

  # And the reason the denormalised column can be trusted. The boundary policy
  # reads workspace_id without a join, so a row carrying one workspace while
  # pointing at another's channel would be readable from the wrong room. The
  # model derives the value and cannot produce that — which is the same
  # argument the unique index on (channel_id, seq) is kept in spite of.
  test "the database refuses an entry that claims another workspace's channel" do
    theirs = workspace(name: "Globex")

    # As the owner, so row-level security is out of the way and the composite
    # key is what refuses. Under the app role the policy would refuse first,
    # and this would pass while proving something else.
    assert_raises ActiveRecord::InvalidForeignKey do
      as_the_owner do
        ChannelRecord.insert!({ channel_id: @channel.id, workspace_id: theirs.id, seq: 1,
                                kind: "message.created", prev_hash: "0" * 64,
                                entry_hash: Digest::SHA256.hexdigest("planted #{SecureRandom.hex(8)}"),
                                created_at: Time.current })
      end
    end
  end
end
