require "test_helper"

class Memory::LocalTest < ActiveSupport::TestCase
  setup do
    @channel = channel(name: "Meetings")
    @store = Memory::Local.new
  end

  test "context distinguishes what a person stated from what an agent inferred" do
    @store.write(@channel, title: "Monthly reporting", detail: "First Tuesday.", trust: "human")
    @store.write(@channel, title: "Pricing pattern", detail: "Setup cost, not price.", trust: "agent")

    context = @store.context_for(@channel)

    assert_match(/• Monthly reporting/, context)
    assert_match(/◦ Pricing pattern/, context)
    assert context.index("• Monthly") < context.index("◦ Pricing"),
           "human-stated context must come first"
  end

  test "context is nil for a channel that knows nothing" do
    assert_nil @store.context_for(@channel)
  end

  test "a rewritten entry supersedes the previous one under the same key" do
    first = @store.write(@channel, title: "Cadence", detail: "Weekly.", key: "cadence")
    second = @store.write(@channel, title: "Cadence", detail: "Monthly.", key: "cadence")

    assert first.reload.superseded_at, "the previous entry must be superseded, not deleted"
    assert_nil second.superseded_at
    assert_equal [ second ], @channel.memory_entries.current.to_a
  end

  # The contract asks both stores what the room knows after a title is written
  # again, and both answer "the last thing". Only the row can be asked what
  # became of the others, and the answer has to be "they are still here" — this
  # store archives by leaving a superseded row behind, the context database by
  # moving the file, and a correction that deletes satisfies every portable
  # assertion there is (Article P6).
  test "a title written again three times leaves all three versions in the table" do
    3.times { |i| @store.write(@channel, title: "Cadence", detail: "version #{i}") }

    assert_equal 3, @channel.memory_entries.count, "two of the three are history, not nothing"
    assert_equal [ "version 2" ], @channel.memory_entries.current.map(&:detail)
    assert @channel.memory_entries.where(detail: "version 0").first.superseded_at,
           "what the room used to know says when it stopped being true"
  end

  test "search finds an entry by its detail" do
    @store.write(@channel, title: "Acme", detail: "asked for monthly rollups")
    assert_equal [ "Acme" ], @store.search(@channel, "rollups").map(&:title)
    assert_empty @store.search(@channel, "nothing here")
  end

  test "a written entry keeps its provenance" do
    alice = user
    entry = @store.write(@channel, title: "T", detail: "D", trust: "human", author: alice)

    assert_equal alice, entry.author
    assert_equal "human", entry.trust
    assert entry.uri.start_with?(@channel.memory_uri), "the uri must sit under the channel's region"
  end
end
