require "test_helper"

class MemoryEntryTest < ActiveSupport::TestCase
  setup { @channel = channel }

  test "a person's assertion is retrieved before an agent's inference" do
    agent_said = MemoryEntry.create!(channel: @channel, uri: "#{@channel.memory_uri}a",
                                     title: "Inferred", trust: "agent")
    person_said = MemoryEntry.create!(channel: @channel, uri: "#{@channel.memory_uri}b",
                                      title: "Stated", trust: "human")

    assert_equal [ person_said, agent_said ], @channel.memory_entries.by_trust.to_a
  end

  test "superseded entries leave current retrieval" do
    entry = MemoryEntry.create!(channel: @channel, uri: "#{@channel.memory_uri}x", title: "Old")
    assert_includes MemoryEntry.current, entry

    entry.supersede!

    refute_includes MemoryEntry.current, entry
    assert entry.reload.superseded_at, "supersede! must record when, not just that"
  end

  test "trust is constrained to human or agent" do
    entry = MemoryEntry.new(channel: @channel, uri: "#{@channel.memory_uri}y",
                            title: "T", trust: "guess")
    refute entry.valid?
    assert_includes entry.errors[:trust], "is not included in the list"
  end

  test "a uri identifies exactly one entry" do
    MemoryEntry.create!(channel: @channel, uri: "#{@channel.memory_uri}dup", title: "First")
    duplicate = MemoryEntry.new(channel: @channel, uri: "#{@channel.memory_uri}dup", title: "Second")

    refute duplicate.valid?
  end
end
