require "test_helper"

# What the memory panel costs to answer, counted in queries. The sibling of
# test/controllers/api/memory_controller_test.rb, which says what it answers.
#
# Provenance is the expensive part: every entry leads back to a run, the run to
# a session, the session to the person whose agent it was (Article P4). Read one
# entry at a time that is three queries per line of a listing (#177).
class Api::V1::MemoryControllerLoadTest < ActionDispatch::IntegrationTest
  setup { @alice = user(name: "Alice") }

  test "listing what a room knows does not cost a query per entry" do
    little = room_that_learned(2)
    lot    = room_that_learned(8)

    assert_equal listing(little).size, listing(lot).size,
                 "provenance is loaded with the listing, not walked one entry at a time"
  end

  test "a listing loaded in one go still says whose agent recorded each entry" do
    room = room_that_learned(2)

    get api_v1_channel_memory_path(room.slug), headers: auth(@alice)

    assert_response :success
    authors = response.parsed_body.map { |e| e["author"] }
    assert_equal %w[agent agent], authors.map { |a| a["kind"] }
    # Sorted: a listing answers most recent first, which is the store's business
    # and not this file's — what is asserted here is that each line says who.
    assert_equal [ "Colleague 0", "Colleague 1" ], authors.map { |a| a["name"] }.sort
    assert_equal %w[opencode opencode], authors.map { |a| a["agent_kind"] }
    assert authors.all? { |a| a["run_id"].present? },
           "an entry a colleague cannot follow back is a defect (Article P4)"
  end

  private

  # Each entry from a different person's agent: a chain read one entry at a time
  # is only visible when no two entries share the row at the end of it.
  def room_that_learned(count)
    room = channel(slug: "room-#{SecureRandom.hex(3)}")
    count.times do |i|
      speaker = user(name: "Colleague #{i}")
      Memory::Store.current.write(room, title: "Entry #{i}", detail: "What the room learned, #{i}.",
                                  trust: "agent", author: speaker,
                                  source: agent_run(user: speaker, channel: room))
    end
    room
  end

  def listing(room)
    get api_v1_channel_memory_path(room.slug), headers: auth(@alice)
    queries_while { get api_v1_channel_memory_path(room.slug), headers: auth(@alice) }
  end

  # Every statement the request actually sent. Schema reads and the transaction
  # it runs in are not what the room pays for, and a query answered from the
  # request's own cache was never sent.
  def queries_while
    sent = []
    counter = ->(_name, _start, _finish, _id, payload) do
      sent << payload[:sql] unless payload[:cached] || %w[SCHEMA TRANSACTION].include?(payload[:name])
    end
    ActiveSupport::Notifications.subscribed(counter, "sql.active_record") { yield }
    sent
  end
end
