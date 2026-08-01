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
end
