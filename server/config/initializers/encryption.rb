# The keys that encrypt what the database must not hold in the clear.
#
# From the environment, and refused at boot in production rather than discovered the
# first time somebody saves a key — the same shape as `cors.rb`, and for the same
# reason: a server that will not start is a smaller problem than one that started
# misconfigured.
#
# Derived from `secret_key_base` in development and test. Not a shortcut for
# production: derivation means rotating the base silently invalidates every stored
# credential, which is recoverable when the stored thing is a key somebody can paste
# again and is not a thing to decide for an operator.
module Encryption
  KEYS = %w[primary_key deterministic_key key_derivation_salt].freeze

  def self.configure(config)
    from_env = KEYS.index_with { |name| ENV["WORKROOM_ENCRYPTION_#{name.upcase}"].presence }

    if from_env.values.any?(&:nil?)
      # SECRET_KEY_BASE_DUMMY marks asset precompilation inside an image, where no
      # secret is set and none can be. Elsewhere in production this is fatal.
      if Rails.env.production? && ENV["SECRET_KEY_BASE_DUMMY"].blank?
        missing = from_env.select { |_, v| v.nil? }.keys
                          .map { |name| "WORKROOM_ENCRYPTION_#{name.upcase}" }
        raise "#{missing.join(', ')} must be set in production"
      end

      base = config.secret_key_base
      from_env = KEYS.index_with { |name| Digest::SHA256.hexdigest("#{base}:#{name}") }
    end

    KEYS.each { |name| config.active_record.encryption.public_send(:"#{name}=", from_env[name]) }
  end
end

Rails.application.configure { Encryption.configure(config) }
