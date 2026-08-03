require "test_helper"

class Api::V1::ChannelsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @alice = user(name: "Alice")
    @json = { "Content-Type" => "application/json" }
  end

  test "a workspace is offered a shape rather than a blank page" do
    get api_v1_channel_templates_path, headers: auth(@alice)

    assert_response :success
    keys = response.parsed_body.map { |t| t["key"] }
    assert_includes keys, "engineering"
    assert response.parsed_body.all? { |t| t["purpose"].present? }, "a room without a purpose is a blank page"
  end

  test "a template says which rooms already exist, so none is offered twice" do
    channel(slug: "strategy", name: "Strategy")

    get api_v1_channel_templates_path, headers: auth(@alice)

    taken = response.parsed_body.find { |t| t["key"] == "strategy" }
    assert_equal true, taken["taken"]
  end

  test "creating from a template gives the room and its skills" do
    post api_v1_channels_path, params: { template: "engineering" }.to_json,
         headers: auth(@alice).merge(@json)

    assert_response :created
    assert_equal "engineering", response.parsed_body["slug"]
    created = Channel.find_by!(slug: "engineering")
    assert_equal [ "Recording an architectural decision" ],
                 Memory::Store.current.skills(created).map(&:title)
    # Through the store, not the table: a skill is a row there too, and what
    # this asserts is that the room was given no *knowledge* it did not earn.
    assert_empty Memory::Store.current.all(created), "somebody else's facts are not this room's"
  end

  test "the template path carries the visibility the request asked for" do
    post api_v1_channels_path, params: { template: "legal", visibility: "private" }.to_json,
         headers: auth(@alice).merge(@json)

    assert_response :created
    assert_equal "private", Channel.find_by!(slug: "legal").visibility
  end

  test "a template nobody defined is refused rather than made empty" do
    post api_v1_channels_path, params: { template: "astrology" }.to_json,
         headers: auth(@alice).merge(@json)

    assert_response :not_found
    assert_nil Channel.find_by(slug: "astrology")
  end

  test "a room can still be made without a template" do
    post api_v1_channels_path, params: { slug: "nordwind", name: "Nordwind" }.to_json,
         headers: auth(@alice).merge(@json)

    assert_response :created
    assert_equal "Nordwind", Channel.find_by!(slug: "nordwind").name
  end

  # What the room's journal holds about the change. The row names the entry by
  # its hash; what it says lives in the object store under that address.
  def journal_payload(room, kind: "channel.updated")
    entry = ChannelRecord.find_by!(channel: room, kind:)
    JSON.parse(RecordStore::Objects.current.get(entry.entry_hash))["payload"]
  end

  test "a member names the room's repository, and the room remembers who" do
    room = channel(slug: "widgets")
    room.memberships.create!(user: @alice, role: "owner")

    patch api_v1_channel_path(room.slug),
          params: { repository_url: "https://github.com/acme/widgets" }.to_json,
          headers: auth(@alice).merge(@json)

    assert_response :success
    assert_equal "https://github.com/acme/widgets", response.parsed_body["repository_url"]
    assert_equal "https://github.com/acme/widgets", room.reload.repository_url

    assert_equal(
      { "field" => "repository_url", "from" => nil,
        "to" => "https://github.com/acme/widgets", "author_id" => @alice.id },
      journal_payload(room)
    )
    assert Activity.exists?(actor: @alice, action: "channel.updated", subject: room)
  end

  test "a blank address clears the setting rather than storing whitespace" do
    room = channel(slug: "moved")
    room.memberships.create!(user: @alice)
    room.update!(repository_url: "https://github.com/acme/widgets")

    patch api_v1_channel_path(room.slug),
          params: { repository_url: "   " }.to_json,
          headers: auth(@alice).merge(@json)

    assert_response :success
    assert_nil response.parsed_body["repository_url"]
    assert_nil room.reload.repository_url
    assert_equal({ "field" => "repository_url", "from" => "https://github.com/acme/widgets",
                   "to" => nil, "author_id" => @alice.id }, journal_payload(room))
  end

  test "a setting is not a read: a stranger may not name the room's repository" do
    room = channel(slug: "vault")
    room.update!(visibility: "private")

    patch api_v1_channel_path(room.slug),
          params: { repository_url: "https://github.com/acme/widgets" }.to_json,
          headers: auth(@alice).merge(@json)

    assert_response :forbidden
    assert_nil room.reload.repository_url
    assert_nil ChannelRecord.find_by(channel: room, kind: "channel.updated")
  end

  test "a patch that changes nothing writes no journal entry" do
    room = channel(slug: "settled")
    room.memberships.create!(user: @alice)
    room.update!(repository_url: "https://github.com/acme/widgets")

    assert_no_difference -> { ChannelRecord.where(channel: room).count } do
      patch api_v1_channel_path(room.slug),
            params: { repository_url: "https://github.com/acme/widgets" }.to_json,
            headers: auth(@alice).merge(@json)
    end
    assert_response :success
  end

  test "the room hears when its repository is named" do
    room = channel(slug: "loud")
    room.memberships.create!(user: @alice)

    heard = broadcasts(room) do
      patch api_v1_channel_path(room.slug),
            params: { repository_url: "https://github.com/acme/widgets" }.to_json,
            headers: auth(@alice).merge(@json)
    end

    assert_response :success
    note = heard.find { |p| p[:type] == "channel" }
    assert_not_nil note, "the room was not told its own setting changed"
    assert_equal "https://github.com/acme/widgets", note.dig(:channel, :repository_url)
  end
end
