module RecordStore
  # The other half of the record store: Objects holds the bytes, this holds the
  # order. Every append puts one canonical envelope into the object store under
  # its own digest and writes one row naming it, numbered from the entry before
  # it and carrying that entry's hash — so a reader with the rows and the bucket
  # can tell that nothing was removed from the middle.
  class Append
    # What the first entry in a room points back at. Zeroes rather than nil,
    # because a chain with a nullable link is one every reader has to special
    # case, and the column can then be NOT NULL like every other.
    GENESIS = ("0" * 64).freeze

    # The whole append happens under a lock on the channel row (SELECT … FOR
    # UPDATE), which is the linearisation point: two people posting at the same
    # moment queue here, and the second one reads the first one's entry as its
    # head. The unique index on (channel_id, seq) is the backstop for the case
    # this lock does not cover — a second server, a connection that lost the
    # transaction — where a fork would otherwise reach the table.
    def self.call(channel:, kind:, subject:, payload:)
      channel.with_lock do
        head = channel.channel_records.order(:seq).last
        occurred_at = Time.current

        envelope = {
          "v" => 1,
          "channel_id" => channel.id,
          "seq" => head ? head.seq + 1 : 1,
          "kind" => kind,
          "subject" => { "type" => subject&.class&.polymorphic_name, "id" => subject&.id },
          "prev_hash" => head&.entry_hash || GENESIS,
          "occurred_at" => occurred_at,
          "payload" => payload
        }

        # The digest of the bytes is the address they are stored under, so the
        # row's entry_hash is what Objects hands back rather than a second
        # calculation that could disagree with it.
        entry_hash = Objects.current.put(canonical(envelope))

        channel.channel_records.create!(
          seq: envelope["seq"], kind:, subject:, entry_hash:,
          prev_hash: envelope["prev_hash"], created_at: occurred_at
        )
      end
    end

    # One rendering per set of facts, or the chain records the order somebody's
    # hash happened to be built in. Keys sorted at every level; arrays left
    # exactly as they came, since their order is content rather than notation;
    # times in UTC, because "when" must not depend on who asks.
    #
    # Fifteen lines instead of a gem: canonical JSON is a settled definition and
    # every gem for it brings a dependency to audit for the rest of the series.
    def self.canonical(value)
      JSON.generate(canonicalize(value))
    end

    def self.canonicalize(value)
      case value
      when Hash
        value.map { |key, inner| [ key.to_s, canonicalize(inner) ] }.sort_by(&:first).to_h
      when Array
        value.map { |item| canonicalize(item) }
      when Time, DateTime
        value.utc.iso8601(3)
      when Date
        value.iso8601
      else
        value
      end
    end

    private_class_method :canonical, :canonicalize
  end
end
