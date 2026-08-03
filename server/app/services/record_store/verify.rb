module RecordStore
  # The journal, checked rather than trusted. Append writes the chain; this
  # reads the rows and the stored bytes back and recomputes it. That difference
  # is the whole value of the record: integrity that rests on the writer having
  # been careful is a promise, and integrity a stranger can recompute from what
  # was kept is evidence.
  #
  # So nothing is borrowed from Append here but the format itself — not its
  # canonicaliser, not its idea of what the head was. A verifier assembled out
  # of the writer's own helpers can only establish that the writer agrees with
  # itself, which is exactly what was already assumed.
  #
  # Three things are proved, and each catches a tamper the others let through:
  # the sequence runs from one with no gaps (a removed row leaves everything
  # else hashing correctly), each prev_hash names the entry before it (a
  # reordering leaves every entry intact), and the object under each entry_hash
  # re-hashes to that hash and says of itself what the row says of it (a row
  # re-pointed at another real envelope passes a digest check alone).
  #
  # What it cannot prove is authorship. Nothing is signed yet, so a rewrite that
  # recomputes the whole chain from the point it touched verifies clean — see
  # docs/spikes/record-store.md.
  class Verify
    Result = Struct.new(:entries, :failures) do
      def ok? = failures.empty?
    end

    def self.call(channel) = new(channel).call

    def initialize(channel)
      @channel = channel
      @failures = []
    end

    # Every discrepancy, not the first one. A room being told that something
    # somewhere is wrong learns the least useful thing there is to know, and
    # turns each verification into one more round trip.
    def call
      records = @channel.channel_records.order(:seq).to_a
      expected_seq = 1
      expected_prev = Append::GENESIS

      records.each do |record|
        check_numbering(record, expected_seq)
        check_link(record, expected_prev)
        check_envelope(record)

        expected_seq = record.seq + 1
        expected_prev = record.entry_hash
      end

      Result.new(records.length, @failures)
    end

    private
      # The unique index on (channel_id, seq) and the ordering together mean the
      # numbers only ever run forwards, so an unexpected one is always a gap.
      def check_numbering(record, expected)
        return if record.seq == expected

        gap = expected == record.seq - 1 ? "seq #{expected}" : "seq #{expected}-#{record.seq - 1}"
        discrepancy "#{gap}: missing from the journal, which goes straight to seq #{record.seq}"
      end

      def check_link(record, expected)
        return if record.prev_hash == expected

        discrepancy "seq #{record.seq}: prev_hash #{abbrev(record.prev_hash)} does not name " \
                    "the entry before it (#{abbrev(expected)})"
      end

      def check_envelope(record)
        bytes = Objects.current.get(record.entry_hash)
        if bytes.nil?
          return discrepancy("seq #{record.seq}: no envelope is stored under " \
                             "#{abbrev(record.entry_hash)}")
        end

        digest = Digest::SHA256.hexdigest(bytes)
        if digest != record.entry_hash
          return discrepancy("seq #{record.seq}: the stored envelope hashes to #{abbrev(digest)}, " \
                             "not to the #{abbrev(record.entry_hash)} it is filed under")
        end

        # Only reached once the bytes are known to be the bytes that hash to the
        # address they were fetched from, so they parse.
        check_fields(record, JSON.parse(bytes))
      end

      # An envelope that hashes correctly is still only some entry; these say it
      # is this one. Without them a row could be re-pointed at any other
      # envelope ever stored and the digest would agree.
      def check_fields(record, envelope)
        { "channel_id" => record.channel_id, "seq" => record.seq,
          "kind" => record.kind, "prev_hash" => record.prev_hash }.each do |field, expected|
          next if envelope[field] == expected

          discrepancy "seq #{record.seq}: the envelope says #{field} #{envelope[field].inspect}, " \
                      "the row says #{expected.inspect}"
        end
      end

      def discrepancy(line) = @failures << line

      # Enough of a digest to tell two apart and to grep the store with, without
      # a report where every line runs past the width of a terminal.
      def abbrev(sha256) = "#{sha256[0, 12]}…"
  end
end
