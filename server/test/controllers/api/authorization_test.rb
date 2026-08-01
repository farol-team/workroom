require "test_helper"

# Every channel-scoped endpoint, in one table.
#
# `authorize_channel!` used to render and return, so each action had to remember
# `return if performed?`. #4 proved that it would not be remembered: the approve
# action rendered 403 and then rendered again. A guard that depends on being
# remembered is not a guard.
#
# An endpoint added later without the filter fails here rather than shipping a
# double render.
class Api::V1::AuthorizationTest < ActionDispatch::IntegrationTest
  setup do
    @channel = Channel.create!(slug: "private-#{SecureRandom.hex(3)}", name: "Private",
                               visibility: "private")
    @owner = user(name: "Owner")
    @channel.memberships.create!(user: @owner, role: "owner")
    @outsider = user(name: "Outsider")
    @json = { "Content-Type" => "application/json" }

    session = AgentSession.create!(user: @owner, channel: @channel, agent_kind: "opencode")
    @run = session.agent_runs.create!(status: "succeeded")
  end

  def endpoints
    [
      [ :get,  -> { api_v1_channel_path(@channel.slug) },           nil ],
      [ :get,  -> { api_v1_channel_context_path(@channel.slug) },   nil ],
      [ :post, -> { api_v1_channel_messages_path(@channel.slug) },  { body: "hello" } ],
      [ :get,  -> { api_v1_channel_memory_path(@channel.slug) },    nil ],
      [ :post, -> { api_v1_channel_memory_path(@channel.slug) },    { title: "T", detail: "D" } ],
      [ :post, -> { api_v1_channel_runs_path(@channel.slug) },      {} ],
      [ :get,  -> { api_v1_channel_artifacts_path(@channel.slug) }, nil ],
      [ :post, -> { api_v1_rail_path(@channel.slug) },              { jsonrpc: "2.0", id: 1, method: "tools/list" } ]
    ]
  end

  test "a non-member is refused by every channel-scoped endpoint, exactly once" do
    endpoints.each do |verb, path, body|
      send(verb, instance_exec(&path),
           params: body&.to_json, headers: auth(@outsider).merge(@json))

      assert_response :forbidden,
                      "#{verb.to_s.upcase} #{instance_exec(&path)} let an outsider through"
    end
  end

  test "a member is not refused by any of them" do
    endpoints.each do |verb, path, body|
      send(verb, instance_exec(&path),
           params: body&.to_json, headers: auth(@owner).merge(@json))

      refute_equal 403, response.status,
                   "#{verb.to_s.upcase} #{instance_exec(&path)} refused a member"
    end
  end

  test "an unauthenticated request is refused before authorization is considered" do
    endpoints.each do |verb, path, body|
      send(verb, instance_exec(&path), params: body&.to_json, headers: @json)

      assert_response :unauthorized,
                      "#{verb.to_s.upcase} #{instance_exec(&path)} did not require a token"
    end
  end

  test "an open channel admits anyone" do
    open_channel = channel
    get api_v1_channel_path(open_channel.slug), headers: auth(@outsider)

    assert_response :success
  end
end
