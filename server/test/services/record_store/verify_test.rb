require "test_helper"

# What turns the journal from a claim into evidence. Append writes the chain;
# this reads it back and recomputes it from the rows and the stored bytes, so
# almost every spec here is a tamper. The model refuses an edit and the object
# store never deletes, which means each tamper has to go round them — raw SQL,
# or reaching into the service directly. That is the point rather than a
# shortcut: the reader this exists for is the one who did go round them.
class RecordStore::VerifyTest < ActiveSupport::TestCase
  setup do
    @channel = channel
  end

  def append(kind: "message.created", payload: { "body" => "hello" })
    RecordStore::Append.call(channel: @channel, kind:, subject: nil, payload:)
  end

  def journal(length) = Array.new(length) { |i| append(payload: { "body" => "entry #{i}" }) }

  def verify = RecordStore::Verify.call(@channel)

  # Round the readonly model, which is what a tamperer would have to do.
  def tamper(sql) = ActiveRecord::Base.connection.execute(sql)

  def assert_names_seq(seq, result)
    assert_not result.ok?, "the journal verified clean while it was tampered with"
    assert result.failures.any? { |failure| failure.include?("seq #{seq}") },
           "no failure named seq #{seq}: #{result.failures.inspect}"
  end

  test "a journal written through Append verifies clean" do
    journal(3)

    result = verify

    assert result.ok?, result.failures.join("; ")
    assert_equal 3, result.entries
    assert_empty result.failures
  end

  # A room nobody has written in yet has an intact chain of nothing. The verdict
  # has to say so rather than complain about the missing first entry, or every
  # new room fails the check on the day it opens.
  test "a room with no journal has nothing to disagree with" do
    result = verify

    assert result.ok?, result.failures.join("; ")
    assert_equal 0, result.entries
  end

  # The row says it is X, the object store has nothing under X. The digest is
  # the address, so an entry_hash somebody rewrote points at bytes that were
  # never stored — there is nothing to re-hash, and that is itself the answer.
  test "an entry_hash rewritten in place is caught" do
    entries = journal(3)
    forged = Digest::SHA256.hexdigest("forged #{SecureRandom.hex(8)}")

    tamper("UPDATE channel_records SET entry_hash = '#{forged}' WHERE id = #{entries.second.id}")

    assert_names_seq 2, verify
  end

  # The link, not the entry. Both rows are intact and both envelopes are where
  # they should be; what is wrong is which entry the third one claims to follow,
  # which is exactly what a chain is for.
  test "a prev_hash rewritten in place is caught" do
    entries = journal(3)

    tamper("UPDATE channel_records SET prev_hash = '#{entries.first.entry_hash}' " \
           "WHERE id = #{entries.third.id}")

    assert_names_seq 3, verify
  end

  # Removing a row leaves a journal that is internally tidy — every remaining
  # entry hashes correctly — and still says less than it did. Numbering from one
  # with no gaps is what makes the removal visible.
  test "a row removed from the middle leaves a gap the chain shows" do
    entries = journal(4)

    tamper("DELETE FROM channel_records WHERE id = #{entries.second.id}")

    result = verify

    assert_names_seq 2, result
    assert_equal 3, result.entries
  end

  test "an envelope missing from the object store is caught" do
    entries = journal(2)

    ActiveStorage::Blob.service.delete("record/sha256/#{entries.second.entry_hash}")

    assert_names_seq 2, verify
  end

  # The case a digest check alone would pass: the row is re-pointed at bytes
  # that really are stored under that address, so the hash agrees with itself
  # and only the envelope's own account of where it sits gives it away. Without
  # comparing the envelope's fields against the row, any entry could be swapped
  # for any other entry ever written.
  test "an entry re-pointed at an envelope that is not its own is caught" do
    entries = journal(2)
    elsewhere = RecordStore::Objects.current.put(
      JSON.generate({ "v" => 1, "channel_id" => @channel.id, "seq" => 9,
                      "kind" => "message.created", "prev_hash" => "0" * 64,
                      "occurred_at" => Time.current.utc.iso8601(3),
                      "payload" => { "body" => "somewhere else #{SecureRandom.hex(8)}" } })
    )

    tamper("UPDATE channel_records SET entry_hash = '#{elsewhere}' WHERE id = #{entries.second.id}")

    assert_names_seq 2, verify
  end

  # A room deserves the whole picture. Stopping at the first discrepancy turns
  # every verification into one more round trip, and tells whoever is reading
  # the least useful thing it could: that something, somewhere, is wrong.
  test "every discrepancy is reported, not only the first" do
    entries = journal(4)

    [ entries.second, entries.fourth ].each do |entry|
      forged = Digest::SHA256.hexdigest("forged #{SecureRandom.hex(8)}")
      tamper("UPDATE channel_records SET entry_hash = '#{forged}' WHERE id = #{entry.id}")
    end

    result = verify

    assert_names_seq 2, result
    assert_names_seq 4, result
  end

  # Verification is per room. A neighbour with a broken journal is not this
  # room's verdict, and this room's clean journal is not the neighbour's.
  test "one room's damage is not another room's verdict" do
    journal(2)
    neighbour = channel(name: "Marketing")
    theirs = RecordStore::Append.call(channel: neighbour, kind: "message.created",
                                      subject: nil, payload: { "body" => "theirs" })
    forged = Digest::SHA256.hexdigest("forged #{SecureRandom.hex(8)}")
    tamper("UPDATE channel_records SET entry_hash = '#{forged}' WHERE id = #{theirs.id}")

    assert verify.ok?, verify.failures.join("; ")
    assert_not RecordStore::Verify.call(neighbour).ok?
  end
end
