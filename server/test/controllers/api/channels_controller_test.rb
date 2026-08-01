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
end
