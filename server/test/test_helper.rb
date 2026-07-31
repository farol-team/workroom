ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"
require "rails/test_help"

module Build
  module_function

  def user(name: "Alice", email: nil)
    email ||= "#{name.downcase}-#{SecureRandom.hex(3)}@example.test"
    User.create!(name:, email:, provider: "test", uid: email, api_token: SecureRandom.hex(8))
  end

  def channel(slug: nil, name: "Meetings")
    slug ||= "chan-#{SecureRandom.hex(3)}"
    Channel.create!(slug:, name:)
  end

  def session_for(user, channel)
    AgentSession.create!(user:, channel:, agent_kind: "opencode", status: "idle")
  end

  def agent_run(user:, channel:, trigger: nil)
    session_for(user, channel).agent_runs.create!(status: "running", trigger_message: trigger)
  end
end

class ActiveSupport::TestCase
  parallelize(workers: 1)
  include Build

  # Capture what the room would see, without stubbing the broadcast path away.
  def broadcasts(channel)
    captured = []
    stream = Broadcast.stream_for(channel)
    original = ActionCable.server.method(:broadcast)
    ActionCable.server.define_singleton_method(:broadcast) do |target, payload|
      captured << payload if target == stream
      original.call(target, payload)
    end
    yield
    captured
  ensure
    ActionCable.server.singleton_class.send(:remove_method, :broadcast)
  end
end

class ActionDispatch::IntegrationTest
  include Build

  def auth(user) = { "Authorization" => "Bearer #{user.api_token}" }
end
