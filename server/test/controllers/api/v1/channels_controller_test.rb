require "test_helper"

# What a room costs to answer for, counted in queries.
#
# A sibling of test/controllers/api/channels_controller_test.rb rather than a
# second half of it: that file says what the endpoints answer, this one says
# what answering costs, and the two go red for different reasons. The count of
# queries is the only figure here that does not move with the machine the suite
# runs on — and an N+1 is precisely a figure that grows with the room (#177).
class Api::V1::ChannelsControllerLoadTest < ActionDispatch::IntegrationTest
  setup { @alice = user(name: "Alice") }

  test "the sidebar's message counts cost one query however many rooms there are" do
    3.times do |i|
      room = channel(slug: "room-#{i}", name: "Room #{i}")
      2.times { |n| room.messages.create!(author: @alice, body: "said #{n}") }
    end

    sent = queries_while { get api_v1_channels_path, headers: auth(@alice) }

    assert_response :success
    assert_equal [ 2, 2, 2 ], response.parsed_body.map { |c| c["message_count"] },
                 "the sidebar shows what it always showed"
    assert_equal 1, sent.count { |sql| sql.match?(/COUNT.*FROM "messages"/i) },
                 "one grouped count for the whole sidebar, not one per room paid on every refresh (#99, #177)"
  end

  test "opening a room does not cost a query per message in it" do
    quiet = room_where_agents_spoke(2)
    busy  = room_where_agents_spoke(8)

    assert_equal opening(quiet).size, opening(busy).size,
                 "what a room costs to open is a property of the room, not of how much was said in it"
  end

  test "a room opened in one go still says whose agent spoke" do
    room = room_where_agents_spoke(2)

    get api_v1_channel_path(room.slug), headers: auth(@alice)

    assert_response :success
    authors = response.parsed_body["messages"].map { |m| m["author"] }
    assert_equal %w[agent agent], authors.map { |a| a["kind"] }
    assert_equal [ "Colleague 0", "Colleague 1" ], authors.map { |a| a["name"] },
                 "a message written by an agent still belongs to a person"
    assert_equal %w[opencode opencode], authors.map { |a| a["agent_kind"] }
  end

  private

  # Each answer from a different person's agent, so a serializer that reads them
  # one at a time cannot be rescued by the request's query cache — eight reads of
  # the same row would be one query and would hide exactly what this measures.
  def room_where_agents_spoke(count)
    room = channel(slug: "room-#{SecureRandom.hex(3)}", name: "Room #{SecureRandom.hex(3)}")
    count.times do |i|
      speaker = user(name: "Colleague #{i}")
      room.messages.create!(author: agent_run(user: speaker, channel: room), body: "answer #{i}")
    end
    room
  end

  # The first visit to a room is also where the membership is made; the second is
  # what a person pays every time after that, which is the one worth measuring.
  def opening(room)
    get api_v1_channel_path(room.slug), headers: auth(@alice)
    queries_while { get api_v1_channel_path(room.slug), headers: auth(@alice) }
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
