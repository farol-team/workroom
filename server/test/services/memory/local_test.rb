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

  # The contract asks what the room has after a procedure is written again, and
  # a store that deleted the old one answers that question correctly. Only the
  # row can be asked what became of it — the context database moves a file
  # instead, and nothing on the seam reads either place — so the half that says
  # "corrected, not erased" is asked here, as it already is for `write` above.
  test "a skill rewritten under the same title supersedes the previous one" do
    first = @store.write_skill(@channel, title: "Running a client call", body: "Agenda first.")
    second = @store.write_skill(@channel, title: "Running a client call",
                                body: "Agenda out the day before.")

    assert first.reload.superseded_at, "the previous procedure must be superseded, not deleted"
    assert_nil second.superseded_at
    assert_equal [ second ], @store.skills(@channel).to_a
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
