require "test_helper"
require "rake"

Rails.application.load_tasks unless Rake::Task.task_defined?("record:verify")

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

  # A room of its own, in a workspace that is not necessarily this test's. The
  # entered block is how anything reaches another workspace at all — the
  # boundary is the database's, so a channel created outside it would be
  # refused rather than misfiled.
  def room_in(workspace, slug:, entries: 1)
    workspace.entered do
      room = Channel.create!(slug:, name: slug.capitalize)
      entries.times do |i|
        RecordStore::Append.call(channel: room, kind: "message.created", subject: nil,
                                 payload: { "body" => "#{slug} #{i}" })
      end
      room
    end
  end

  TaskRun = Struct.new(:out, :err, :aborted)

  # The task in process, which also means under the app role the suite confines
  # to — the role a deployment uses, and the one that has row-level security
  # applied to it. Run any other way it would be checked by a connection that
  # bypasses the boundary, and the only thing worth proving about the task is
  # which rooms it reaches.
  def run_task(*args)
    Rake::Task["record:verify"].reenable
    aborted = false
    out, err = capture_io do
      Rake::Task["record:verify"].invoke(*args)
    rescue SystemExit
      aborted = true
    end
    TaskRun.new(out, err, aborted)
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

  # The digest check earns its keep only if bytes can change under a stable
  # address, and they can: the Disk service writes what it is handed to the
  # path a key names, and an S3 bucket somebody has write access to is the same
  # story. Nothing is missing here and nothing was re-pointed — the row is
  # filed under an address the bytes no longer hash to.
  test "an envelope rewritten in place under its own address is caught" do
    entries = journal(2)
    key = "record/sha256/#{entries.second.entry_hash}"

    ActiveStorage::Blob.service.upload(key, StringIO.new("not the envelope #{SecureRandom.hex(8)}".b))

    result = verify

    assert_names_seq 2, result
    assert result.failures.any? { |failure| failure.include?("hashes to") },
           "the failure blames something other than the digest: #{result.failures.inspect}"
  end

  # --- the rake task ---------------------------------------------------------
  #
  # The task holds no verification logic, so what is worth proving about it is
  # what the service cannot: which rooms it reaches, whose they are, and what
  # it exits with. Reaching them is not a detail — the boundary is the
  # database's, and a checker that enters no workspace sees no rooms and calls
  # that a clean record.

  test "every workspace's rooms are checked, and each line names whose room it is" do
    mine = Current.workspace
    theirs = workspace(name: "Globex")
    room_in(mine, slug: "meetings")
    room_in(theirs, slug: "meetings")

    run = run_task

    assert_not run.aborted, "#{run.out}#{run.err}"
    assert_includes run.out, "#{mine.slug}/meetings: OK (1 entries)"
    assert_includes run.out, "#{theirs.slug}/meetings: OK (1 entries)"
  end

  # Two rooms of the same name in different workspaces is the ordinary case —
  # slugs are unique per workspace, not globally. Each workspace answers for
  # its own, and a broken one anywhere is the verdict for the run.
  test "the slug form checks each workspace's own room of that name" do
    mine = Current.workspace
    theirs = workspace(name: "Globex")
    room_in(mine, slug: "meetings")
    broken = room_in(theirs, slug: "meetings")
    theirs.entered do
      tamper("UPDATE channel_records SET entry_hash = " \
             "'#{Digest::SHA256.hexdigest("forged #{SecureRandom.hex(8)}")}' " \
             "WHERE channel_id = #{broken.id}")
    end

    run = run_task("meetings")

    assert run.aborted, "a journal that does not verify must leave a nonzero exit: #{run.out}"
    assert_includes run.out, "#{mine.slug}/meetings: OK (1 entries)"
    assert_includes run.out, "#{theirs.slug}/meetings: seq 1:"
    assert_not_includes run.out, "#{mine.slug}/meetings: seq"
  end

  # Silence would read as a room that verified, which is the one answer a
  # checker must never give by accident.
  test "a slug no room anywhere answers to is refused, not passed over" do
    run = run_task("no-such-room")

    assert run.aborted, "an unknown slug left a zero exit: #{run.out}"
    assert_includes run.err, "no-such-room"
  end
end
