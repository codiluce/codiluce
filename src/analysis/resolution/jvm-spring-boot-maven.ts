import { xmlChild, xmlValue, type XmlNode } from './jvm-manifest.js';
import { BOOT_GRADLE_VERSION } from './jvm-spring-boot.js';
import { BOOT35_VERSION, BOOT35_BOM_PROPERTIES } from './jvm-spring-boot35.js';

/** Published Boot 3.5.16/4.0.8 parent/BOM data only. No Maven resolver, plugin or
 * target compiler executes. Explicit disabled local lookup prevents this
 * source contract from hiding a denied or conflicting local parent.
 * https://docs.spring.io/spring-boot/4.0/maven-plugin/using.html
 */
export const BOOT_MAVEN_PARENT = `org.springframework.boot:spring-boot-starter-parent:${BOOT_GRADLE_VERSION}`;
export const bootMavenDefaults = {
    'java.version': '17',
    'maven.compiler.release': '${java.version}',
    'project.build.sourceEncoding': 'UTF-8',
    'project.reporting.outputEncoding': 'UTF-8',
    'resource.delimiter': '@',
};
// Names from the exact published spring-boot-dependencies 4.0.8 descriptor.
// Application-specific properties are independent; overriding managed inputs
// requires a reviewed dependency/compiler selection rather than a guessed BOM.
const bomProperties = new Set(["activemq.version","angus-mail.version","artemis.version","aspectj.version","assertj.version","awaitility.version","brave.version","build-helper-maven-plugin.version","byte-buddy.version","cache2k.version","caffeine.version","cassandra-driver.version","classmate.version","commons-codec.version","commons-dbcp2.version","commons-lang3.version","commons-logging.version","commons-pool.version","commons-pool2.version","couchbase-client.version","crac.version","cyclonedx-maven-plugin.version","db2-jdbc.version","dependency-management-plugin.version","derby.version","ehcache3.version","elasticsearch-client.version","flyway.version","freemarker.version","git-commit-id-maven-plugin.version","glassfish-jaxb.version","glassfish-jstl.version","graphql-java.version","groovy.version","gson.version","h2.version","hamcrest.version","hazelcast.version","hibernate-validator.version","hibernate.version","hikaricp.version","hsqldb.version","htmlunit.version","httpasyncclient.version","httpclient5.version","httpcore.version","httpcore5.version","infinispan.version","influxdb-java.version","jackson-2-bom.version","jackson-bom.version","jakarta-activation.version","jakarta-annotation.version","jakarta-inject.version","jakarta-jms.version","jakarta-json-bind.version","jakarta-json.version","jakarta-mail.version","jakarta-management.version","jakarta-persistence.version","jakarta-servlet-jsp-jstl.version","jakarta-servlet.version","jakarta-transaction.version","jakarta-validation.version","jakarta-websocket.version","jakarta-ws-rs.version","jakarta-xml-bind.version","jakarta-xml-soap.version","jakarta-xml-ws.version","janino.version","javax-cache.version","javax-money.version","jaxen.version","jaybird.version","jboss-logging.version","jdom2.version","jedis.version","jersey.version","jetty-reactive-httpclient.version","jetty.version","jmustache.version","jooq.version","json-path.version","json-smart.version","jsonassert.version","jspecify.version","jtds.version","junit-jupiter.version","junit.version","kafka.version","kotlin-coroutines.version","kotlin-serialization.version","kotlin.version","lettuce.version","liquibase.version","log4j2.version","logback.version","lombok.version","mariadb.version","maven-antrun-plugin.version","maven-assembly-plugin.version","maven-clean-plugin.version","maven-compiler-plugin.version","maven-dependency-plugin.version","maven-deploy-plugin.version","maven-enforcer-plugin.version","maven-failsafe-plugin.version","maven-help-plugin.version","maven-install-plugin.version","maven-invoker-plugin.version","maven-jar-plugin.version","maven-javadoc-plugin.version","maven-resources-plugin.version","maven-shade-plugin.version","maven-source-plugin.version","maven-surefire-plugin.version","maven-war-plugin.version","micrometer-tracing.version","micrometer.version","mockito.version","mongodb.version","mssql-jdbc.version","mysql.version","native-build-tools-plugin.version","nekohtml.version","neo4j-java-driver.version","netty.version","opentelemetry.version","oracle-database.version","oracle-r2dbc.version","pooled-jms.version","postgresql.version","prometheus-client.version","prometheus-simpleclient.version","pulsar.version","quartz.version","querydsl.version","r2dbc-h2.version","r2dbc-mariadb.version","r2dbc-mssql.version","r2dbc-mysql.version","r2dbc-pool.version","r2dbc-postgresql.version","r2dbc-proxy.version","r2dbc-spi.version","rabbit-amqp-client.version","rabbit-stream-client.version","reactive-streams.version","reactor-bom.version","rsocket.version","rxjava3.version","saaj-impl.version","selenium-htmlunit.version","selenium.version","sendgrid.version","slf4j.version","snakeyaml.version","spring-amqp.version","spring-batch.version","spring-data-bom.version","spring-framework.version","spring-graphql.version","spring-hateoas.version","spring-integration.version","spring-kafka.version","spring-ldap.version","spring-pulsar.version","spring-restdocs.version","spring-security.version","spring-session.version","spring-ws.version","sqlite-jdbc.version","testcontainers-redis-module.version","testcontainers.version","thymeleaf-extras-data-attribute.version","thymeleaf-extras-springsecurity.version","thymeleaf-layout-dialect.version","thymeleaf.version","tomcat.version","unboundid-ldapsdk.version","versions-maven-plugin.version","vibur.version","webjars-locator-core.version","webjars-locator-lite.version","wsdl4j.version","xml-maven-plugin.version","xmlunit2.version","yasson.version","zipkin-reporter.version"]);

export function reviewedBootMavenParent(node: XmlNode | undefined): boolean {
    if (!node || node.children.some(child => !['groupId','artifactId','version','relativePath'].includes(child.name))) return false;
    const relative = xmlChild(node, 'relativePath');
    return !!relative && relative.children.length === 0 && relative.text.trim() === ''
        && xmlValue(node,'groupId') === 'org.springframework.boot' && xmlValue(node,'artifactId') === 'spring-boot-starter-parent'
        && [BOOT_GRADLE_VERSION, BOOT35_VERSION].includes(xmlValue(node, 'version') ?? '');
}

export function bootMavenPropertyGap(name: string, value: string, version = BOOT_GRADLE_VERSION): string | undefined {
    if (version === BOOT35_VERSION ? BOOT35_BOM_PROPERTIES.includes(name) : bomProperties.has(name)) return `Maven property ${name} overrides the reviewed Boot BOM; a selected dependency model is required`;
    if (name === 'java.version') return /^[1-9]\d*$/.test(value) && Number(value) >= 17 && Number(value) <= 2147483647 ? undefined : 'Boot Maven Java version requires a literal supported source/compiler input';
    if (Object.hasOwn(bootMavenDefaults,name)) return value === bootMavenDefaults[name as keyof typeof bootMavenDefaults] ? undefined : `Maven property ${name} changes the reviewed Boot compiler/resource defaults`;
    if (/^(?:maven\.compiler\.|spring-boot\.|kotlin\.|resource\.)/.test(name)) return `Maven property ${name} requires a reviewed Boot compiler/resource profile`;
}

export function reviewedBootMavenPlugin(node: XmlNode, version: string | undefined, parentVersion = BOOT_GRADLE_VERSION): boolean {
    return xmlValue(node,'groupId') === 'org.springframework.boot' && xmlValue(node,'artifactId') === 'spring-boot-maven-plugin'
        && (xmlChild(node,'version') ? version === parentVersion : true)
        && node.children.every(child => ['groupId','artifactId','version'].includes(child.name));
}
