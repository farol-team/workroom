require "test_helper"

# The other half of the record store. Objects hold the bytes; this holds the
# order — one row per thing that happened in a room, numbered from one and
# chained to the row before it, so a reader can tell that nothing was quietly
# removed from the middle.
class RecordStore::AppendTest < ActiveSupport::TestCase
  setup do
    @channel = channel
    @alice = user(name: "Alice")
  end

  def append(channel: @channel, kind: "message.created", subject: nil, payload: { "body" => "hello" })
    RecordStore::Append.call(channel:, kind:, subject:, payload:)
  end

  def envelope_of(record)
    JSON.parse(RecordStore::Objects.current.get(record.entry_hash))
  end

  # JSON.parse keeps the document's order, so re-generating from it shows the
  # order the bytes were written in.
  def payload_bytes(record) = JSON.generate(envelope_of(record)["payload"])

  test "the first entry in a room starts the chain" do
    entry = append

    assert_equal 1, entry.seq
    assert_equal "0" * 64, entry.prev_hash
    assert_equal RecordStore::Append::GENESIS, entry.prev_hash
  end

  test "each entry names the one before it" do
    first = append
    second = append
    third = append

    assert_equal [ 1, 2, 3 ], [ first.seq, second.seq, third.seq ]
    assert_equal first.entry_hash, second.prev_hash
    assert_equal second.entry_hash, third.prev_hash
  end

  # The same chain, read where it will actually be read. record:verify and the
  # git mirror get the envelope out of the object store; a chain that lives
  # only in a column is one the bytes cannot be checked against, and the row
  # could then say anything the exported record does not.
  #
  # A non-genesis entry, because on a room's first entry seq is 1, prev_hash is
  # a constant and the kind is whatever the spec passes most often — three
  # values an envelope could hardcode and still look right.
  test "the stored envelope carries the chain, not only the row" do
    first = append
    second = append(kind: "memory.written")

    envelope = envelope_of(second)

    assert_equal first.entry_hash, envelope["prev_hash"]
    assert_equal 2, envelope["seq"]
    assert_equal "memory.written", envelope["kind"]
    assert_equal second.entry_hash, Digest::SHA256.hexdigest(RecordStore::Objects.current.get(second.entry_hash))
  end

  # A journal per room, not per server: two rooms both hold a first entry, and
  # neither one's numbering says anything about the other's.
  test "every room counts for itself" do
    other = channel(name: "Marketing")

    mine = append
    theirs = append(channel: other)

    assert_equal 1, mine.seq
    assert_equal 1, theirs.seq
    assert_equal RecordStore::Append::GENESIS, theirs.prev_hash
  end

  # The hash is the address, exactly as it is for a payload: an entry that says
  # it is X can be fetched by X and checked against itself, with no index in
  # between to be wrong.
  test "the entry's envelope is retrievable from the object store by its own hash" do
    entry = append

    bytes = RecordStore::Objects.current.get(entry.entry_hash)

    assert_not_nil bytes, "the envelope was never stored under the hash the row carries"
    assert_equal entry.entry_hash, Digest::SHA256.hexdigest(bytes)
  end

  test "the envelope carries what happened, not only that something did" do
    message = @channel.messages.create!(author: @alice, body: "hello")

    entry = append(kind: "message.created", subject: message, payload: { "body" => "hello" })
    envelope = envelope_of(entry)

    assert_equal 1, envelope["v"]
    assert_equal @channel.id, envelope["channel_id"]
    assert_equal entry.seq, envelope["seq"]
    assert_equal "message.created", envelope["kind"]
    assert_equal({ "type" => "Message", "id" => message.id }, envelope["subject"])
    assert_equal RecordStore::Append::GENESIS, envelope["prev_hash"]
    assert_equal({ "body" => "hello" }, envelope["payload"])
    assert_in_delta Time.current, Time.iso8601(envelope["occurred_at"]), 5
  end

  # Canonical means one rendering per set of facts. Keys sorted at every level,
  # arrays left exactly as they came — sorting those would change what the
  # envelope says, not just how it is written.
  test "the stored bytes are canonical: keys sorted everywhere, arrays untouched" do
    entry = append(payload: { "z" => 1, "a" => { "d" => [ { "y" => 1, "x" => 2 } ], "b" => 2 },
                              "items" => [ "b", "a" ] })
    envelope = envelope_of(entry)

    assert_keys_sorted envelope
    assert_equal [ "b", "a" ], envelope["payload"]["items"]
  end

  # The reason canonical form is worth the code: two writers holding the same
  # facts in a differently ordered hash must produce the same bytes, or the
  # chain records the order of somebody's ruby literal.
  #
  # Bytes rather than hashes, and two rooms rather than one: an entry_hash
  # covers channel_id, seq, prev_hash and the time it happened, so no two
  # entries anywhere can hash alike and no spec can compare two of them
  # directly. The payload rendering is where a canonicaliser that respected
  # insertion order gets caught, and the digest follows the bytes — entry_hash
  # is pinned to the SHA-256 of exactly what was stored above, so identical
  # bytes cannot hash differently.
  test "the same facts render the same bytes, however the input was ordered" do
    scrambled = append(payload: { "z" => 1, "a" => { "d" => 4, "b" => 2 } })
    ordered = append(channel: channel(name: "Marketing"),
                     payload: { "a" => { "b" => 2, "d" => 4 }, "z" => 1 })

    assert_equal payload_bytes(scrambled), payload_bytes(ordered)
  end

  # The lock serializes writers; this index is what catches the case where it
  # did not. Two entries claiming the same place in the chain is a fork, and a
  # fork that reaches the table is one no reader can resolve afterwards.
  test "the database refuses a second entry claiming a sequence number already taken" do
    first = append

    assert_raises ActiveRecord::RecordNotUnique do
      ChannelRecord.insert!(forced(seq: first.seq, prev_hash: first.prev_hash))
    end
  end

  test "the database refuses the same envelope twice in one room" do
    first = append

    assert_raises ActiveRecord::RecordNotUnique do
      ChannelRecord.insert!(forced(seq: first.seq + 1, prev_hash: first.entry_hash,
                                   entry_hash: first.entry_hash))
    end
  end

  # The journal is part of the write, not a report about it: the entry must
  # live in the caller's transaction and go down with it, rather than reaching
  # the table by some path of its own — a second connection, a commit inside.
  # That the message write is *in* that transaction is the controller's
  # guarantee, and has its own spec there.
  test "a rolled back write leaves no entry behind" do
    ActiveRecord::Base.transaction(requires_new: true) do
      message = @channel.messages.create!(author: @alice, body: "never happened")
      append(subject: message)
      raise ActiveRecord::Rollback
    end

    assert_equal 0, ChannelRecord.where(channel: @channel).count
    assert_equal 0, @channel.messages.count
  end

  # The control for the case above: without it, "no entry" is equally well
  # explained by an append that never wrote one under any circumstances.
  test "a write that is not rolled back does leave an entry" do
    ActiveRecord::Base.transaction(requires_new: true) do
      message = @channel.messages.create!(author: @alice, body: "happened")
      append(subject: message)
    end

    assert_equal 1, ChannelRecord.where(channel: @channel).count
  end

  private
    def forced(seq:, prev_hash:, entry_hash: Digest::SHA256.hexdigest("forced #{SecureRandom.hex(8)}"))
      { workspace_id: @channel.workspace_id, channel_id: @channel.id, seq:, kind: "message.created",
        entry_hash:, prev_hash:, created_at: Time.current }
    end

    def assert_keys_sorted(node, path = "envelope")
      case node
      when Hash
        assert_equal node.keys.sort, node.keys, "#{path} keys are not in canonical order"
        node.each { |key, value| assert_keys_sorted(value, "#{path}.#{key}") }
      when Array
        node.each_with_index { |value, i| assert_keys_sorted(value, "#{path}[#{i}]") }
      end
    end
end
