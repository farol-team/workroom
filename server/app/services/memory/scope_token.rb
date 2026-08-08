module Memory
  # What an agent is allowed to address in the context store, in a form the agent
  # can carry and cannot edit.
  #
  # The store isolates accounts and knows nothing of channels (Article P5), so the
  # channel boundary has to be held by whoever stands in front of it. This token is
  # how the gateway knows, on a request it did not issue, which prefixes were meant
  # and for whom — without asking the caller, who is the one thing here that is not
  # trusted.
  #
  # Short-lived rather than revocable: a session outlives a turn but not a working
  # day, and a list of withdrawn tokens is a second source of truth about access.
  module ScopeToken
    # Ours, and visibly so. Anything without it is refused rather than parsed —
    # a token we did not mint is not a token we should try to understand.
    PREFIX = "wrm_".freeze

    # What a store address looks like, kept here because the gateway asks the same
    # question about arguments it did not write.
    URI_SCHEME = "viking://".freeze

    DEFAULT_TTL = 12.hours

    class << self
      def mint(account:, user_id:, prefixes:, ttl: DEFAULT_TTL)
        payload = encode({ a: account, u: user_id, p: Array(prefixes), exp: ttl.from_now.to_i })
        "#{PREFIX}#{payload}.#{sign(payload)}"
      end

      # The claims, or nil. Never raises and never partially answers: a caller that
      # gets a hash may use every field in it, and one that gets nil has nothing to
      # decide with.
      def verify(token)
        return nil unless token.is_a?(String) && token.start_with?(PREFIX)

        payload, signature = token.delete_prefix(PREFIX).split(".", 2)
        return nil if payload.blank? || signature.blank?
        return nil unless ActiveSupport::SecurityUtils.secure_compare(sign(payload), signature)

        claims = JSON.parse(decode(payload), symbolize_names: true)
        return nil if claims[:exp].to_i <= Time.current.to_i

        { account: claims[:a], user_id: claims[:u], prefixes: Array(claims[:p]) }
      rescue ArgumentError, JSON::ParserError
        # Base64 that is not base64, or JSON that is not JSON. Both mean the same
        # thing as a bad signature, and mean it for the same reason.
        nil
      end

      private

      def sign(payload)
        Base64.urlsafe_encode64(OpenSSL::HMAC.digest("SHA256", secret, payload), padding: false)
      end

      def secret = Rails.application.secret_key_base

      def encode(data) = Base64.urlsafe_encode64(data.to_json, padding: false)

      def decode(payload) = Base64.urlsafe_decode64(payload)
    end
  end
end
