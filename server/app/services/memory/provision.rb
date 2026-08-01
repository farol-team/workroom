require "net/http"

module Memory
  # Giving a workspace its own account in the context store.
  #
  # An account is the store's own unit of isolation — it calls one a workspace,
  # and a second account gets NOT_FOUND rather than a refusal, so existence is
  # not disclosed either (docs/spikes/openviking-isolation.md). Until a room has
  # one it shares whatever the environment names, which is the state every room
  # is in today.
  #
  # Needs the store's root key, which lives wherever the store is deployed and
  # not in this application.
  class Provision
    Error = Class.new(StandardError)

    def initialize(url:, root_key:)
      @url = URI.parse(url.to_s.chomp("/"))
      @root_key = root_key
    end

    # Idempotent by intent rather than by luck: an account that already exists
    # is an error from the store, and re-provisioning a live room would hand it
    # a key its old one no longer matches.
    def call(workspace)
      raise Error, "#{workspace.slug} already has a store" if workspace.openviking_url.present?

      body = post("/api/v1/admin/accounts",
                  account_id: account_id(workspace), admin_user_id: "workroom")
      key = body.dig("result", "user_key")
      raise Error, "the store issued no key for #{workspace.slug}: #{body}" if key.blank?

      workspace.update!(openviking_url: @url.to_s, openviking_api_key: key)
      workspace
    end

    private

    # The store validates these, and a slug is already what a room is called.
    def account_id(workspace) = workspace.slug.gsub(/[^a-zA-Z0-9_-]/, "-")

    def post(path, **payload)
      request = Net::HTTP::Post.new(@url.merge(path))
      request["Authorization"] = "Bearer #{@root_key}"
      request["Content-Type"] = "application/json"
      request.body = payload.to_json

      response = Net::HTTP.start(@url.host, @url.port, use_ssl: @url.scheme == "https") do |http|
        http.request(request)
      end
      raise Error, "#{response.code} from the store: #{response.body}" unless response.is_a?(Net::HTTPSuccess)

      JSON.parse(response.body)
    end
  end
end
